import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateReplyDto {
  @ApiProperty({
    description:
      'Reply text. Platform-specific length limits are enforced by the service ' +
      '(FB 8000, LinkedIn 3000, Instagram 2200 chars).',
    example: 'Thanks for asking — yes, we ship worldwide!',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000) // absolute upper bound; the per-platform limit is checked in the service
  body!: string;
}
