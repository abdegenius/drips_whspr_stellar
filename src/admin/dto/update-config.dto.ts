import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class UpdateConfigDto {
  @IsNotEmpty()
  value: any;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
