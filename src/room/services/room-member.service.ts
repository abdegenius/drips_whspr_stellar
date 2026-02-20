import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RoomMember, MemberRole, MemberStatus } from '../entities/room-member.entity';
import { RoomMemberRepository } from '../repositories/room-member.repository';
import { Room } from '../entities/room.entity';
import { User } from '../../user/entities/user.entity';
import { RedisService } from '../../redis/redis.service';
import {
  ROOM_MEMBER_CONSTANTS,
  ROLE_PERMISSIONS,
  MemberPermission,
  ERROR_MESSAGES,
} from '../constants/room-member.constants';
import { AdminService } from '../../admin/services/admin.service';

@Injectable()
export class RoomMemberService {
  constructor(
    private readonly roomMemberRepository: RoomMemberRepository,
    private readonly roomRepository: RoomRepository,
    @InjectRepository(User)
    private userRepository: any,
    private redisService: RedisService,
    private dataSource: DataSource,
    private readonly adminService: AdminService,
  ) {}

  async joinRoom(userId: string, roomId: string, inviteToken?: string): Promise<RoomMember> {
    // Check if user exists
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    // Check if room exists
    const room = await this.roomRepository.findOne({ where: { id: roomId } });
    if (!room) {
      throw new NotFoundException(ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    // Check if user is already a member
    const existingMember = await this.roomMemberRepository.findMemberWithRole(
      roomId,
      userId,
    );
    if (existingMember && existingMember.status === MemberStatus.ACTIVE) {
      throw new BadRequestException(ERROR_MESSAGES.ALREADY_IN_ROOM);
    }

    // Check max members limit
    const memberCount = await this.roomMemberRepository.countMembers(roomId);
    
    const globalMaxMembers = await this.adminService.getConfigValue<number>(
      'max_room_members',
      ROOM_MEMBER_CONSTANTS.DEFAULT_MAX_MEMBERS,
    );

    const maxMembers = room.maxMembers || globalMaxMembers;
    
    if (memberCount >= maxMembers) {
      throw new BadRequestException(ERROR_MESSAGES.MAX_MEMBERS_REACHED);
    }

    // If invitation token is provided, validate it
    if (inviteToken) {
      const member = await this.roomMemberRepository.findByInviteToken(inviteToken);
      if (!member) {
        throw new BadRequestException(ERROR_MESSAGES.INVALID_INVITE_TOKEN);
      }
    }

    // Create or update member record
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let member: RoomMember;

      if (existingMember) {
        existingMember.status = MemberStatus.ACTIVE;
        existingMember.joinedAt = new Date();
        member = await queryRunner.manager.save(existingMember);
      } else {
        member = new RoomMember();
        member.roomId = roomId;
        member.userId = userId;
        member.role = MemberRole.MEMBER;
        member.status = MemberStatus.ACTIVE;
        member.inviteStatus = 'ACCEPTED';
        member.permissions = ROLE_PERMISSIONS[MemberRole.MEMBER];
        member.joinedAt = new Date();
        member = await queryRunner.manager.save(member);
      }

      await queryRunner.commitTransaction();

      // Invalidate cache
      await this.invalidateMemberCache(roomId, userId);

      return member;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async leaveRoom(userId: string, roomId: string): Promise<void> {
    const member = await this.roomMemberRepository.findMemberWithRole(roomId, userId);
    if (!member) {
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_IN_ROOM);
    }

    member.status = MemberStatus.INACTIVE;
    await this.roomMemberRepository.save(member);

    // Invalidate cache
    await this.invalidateMemberCache(roomId, userId);
  }

  async getMembers(
    roomId: string,
    skip: number = 0,
    take: number = 20,
    role?: MemberRole,
  ): Promise<{ total: number; members: RoomMember[] }> {
    const [members, total] = await this.roomMemberRepository.findRoomMembers(
      roomId,
      skip,
      take,
      role,
    );

    return { total, members };
  }

  async kickMember(
    roomId: string,
    userId: string,
    initiatorId: string,
    reason?: string,
  ): Promise<void> {
    // Check initiator permissions
    const initiator = await this.roomMemberRepository.findMemberWithRole(roomId, initiatorId);
    if (!initiator) {
      throw new ForbiddenException(ERROR_MESSAGES.INSUFFICIENT_PERMISSIONS);
    }

    if (initiator.role === MemberRole.MEMBER) {
      throw new ForbiddenException(ERROR_MESSAGES.INSUFFICIENT_PERMISSIONS);
    }

    // Cannot kick self
    if (userId === initiatorId) {
      throw new BadRequestException(ERROR_MESSAGES.CANNOT_KICK_SELF);
    }

    const member = await this.roomMemberRepository.findMemberWithRole(roomId, userId);
    if (!member) {
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_IN_ROOM);
    }

    // Cannot kick admin if not super admin
    if (member.role === MemberRole.ADMIN && initiator.role !== MemberRole.ADMIN) {
        throw new ForbiddenException(ERROR_MESSAGES.CANNOT_KICK_ADMIN);
    }

    member.status = MemberStatus.REMOVED;
    member.kickedAt = new Date();
    member.kickedBy = initiatorId;
    member.kickReason = reason;

    await this.roomMemberRepository.save(member);

    // Invalidate cache
    await this.invalidateMemberCache(roomId, userId);
  }

  async updateMemberRole(
    roomId: string,
    userId: string,
    newRole: MemberRole,
    initiatorId: string,
  ): Promise<RoomMember> {
    // Check initiator is admin
    const initiator = await this.roomMemberRepository.findMemberWithRole(roomId, initiatorId);
    if (!initiator || initiator.role !== MemberRole.ADMIN) {
      throw new ForbiddenException(ERROR_MESSAGES.INSUFFICIENT_PERMISSIONS);
    }

    const member = await this.roomMemberRepository.findMemberWithRole(roomId, userId);
    if (!member) {
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_IN_ROOM);
    }

    const oldRole = member.role;
    member.role = newRole;
    member.permissions = ROLE_PERMISSIONS[newRole];

    const updated = await this.roomMemberRepository.save(member);

    // Invalidate cache
    await this.invalidateMemberCache(roomId, userId);

    return updated;
  }

  async getMemberPermissions(
    roomId: string,
    userId: string,
  ): Promise<{
    role: MemberRole;
    permissions: MemberPermission[];
    canPerformAction: (action: MemberPermission) => boolean;
  }> {
    const cacheKey = `room:${roomId}:user:${userId}:permissions`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const member = await this.roomMemberRepository.findMemberWithRole(roomId, userId);
    if (!member) {
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_IN_ROOM);
    }

    const permissions = member.permissions || ROLE_PERMISSIONS[member.role];
    
    const result = {
      role: member.role,
      permissions: permissions as MemberPermission[],
      canPerformAction: (action: MemberPermission) => permissions.includes(action),
    };

    await this.redisService.set(
      cacheKey,
      JSON.stringify(result),
      ROOM_MEMBER_CONSTANTS.MEMBER_CACHE_TTL,
    );

    return result;
  }

  async validateMaxMembers(roomId: string): Promise<{ canAdd: boolean; memberCount: number }> {
    const room = await this.roomRepository.findOne({ where: { id: roomId } });
    if (!room) {
      throw new NotFoundException(ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    const memberCount = await this.roomMemberRepository.countMembers(roomId);
    
    const globalMaxMembers = await this.adminService.getConfigValue<number>(
      'max_room_members',
      ROOM_MEMBER_CONSTANTS.DEFAULT_MAX_MEMBERS,
    );

    const maxMembers = room.maxMembers || globalMaxMembers;

    return {
      memberCount,
      canAdd: memberCount < maxMembers,
    };
  }

  async recordMemberActivity(userId: string, roomId: string): Promise<void> {
    const member = await this.roomMemberRepository.findMemberWithRole(roomId, userId);
    if (member) {
      member.lastActivityAt = new Date();
      await this.roomMemberRepository.save(member);
      await this.invalidateMemberCache(roomId, userId);
    }
  }

  async isMember(roomId: string, userId: string): Promise<boolean> {
    return await this.roomMemberRepository.isMember(roomId, userId);
  }

  async getMemberCount(roomId: string): Promise<number> {
    return await this.roomMemberRepository.countMembers(roomId);
  }

  async getAdmins(roomId: string): Promise<RoomMember[]> {
    return await this.roomMemberRepository.findAdmins(roomId);
  }

  private async invalidateMemberCache(roomId: string, userId: string): Promise<void> {
    await this.redisService.del(`room:${roomId}:user:${userId}:permissions`);
    await this.redisService.del(`room:${roomId}:members`);
  }
}
