import { BadRequestException, Body, Controller, Delete, FileTypeValidator, Get, MaxFileSizeValidator, Param, ParseFilePipe, ParseUUIDPipe, Post, Put, Query, Req, UploadedFiles, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { ApplicationRequestDTO, ApplicationResponseDTO, ApplicationStatistics } from "./application.dto";
import { DeleteResult } from "typeorm";
import { AccountRoles } from "src/auth/role.enum";
import { Roles } from "src/auth/roles.decorator";
import { RolesGuard } from "src/auth/roles.guard";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { containsRole } from "src/auth/utils";
import { AuthRequest } from "src/auth/auth-request";
import { Status } from "./status.enum";
import { AccountService } from "src/account/account.service";
import { MinioService } from "src/minio-s3/minio.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Application, ApplicationType } from "./application.entity";
import { ApplicationProducerService } from "src/application-producer/application-producer.service";
import { SupabaseAuthGuard } from "src/auth/supabase.auth.guard";
import 'multer';
import { v4 as uuidv4 } from 'uuid';

@Controller('applications')
export class ApplicationController {
  constructor(
    private applicationService: ApplicationService,
    private accountService: AccountService,
    private minioService: MinioService,
    private applicationProducerService: ApplicationProducerService,
    @InjectPinoLogger(AccountService.name)
    private readonly logger: PinoLogger,
  ) {}

  // Helper method to validate ApplicationType (case insensitive)
  private validateApplicationType(type: string): ApplicationType {
    const validTypes = Object.values(ApplicationType);
    const upperCaseType = type.toUpperCase();
    
    if (!validTypes.includes(upperCaseType as ApplicationType)) {
      throw new BadRequestException(`Invalid application type. Valid types: ${validTypes.join(', ')}`);
    }
    return upperCaseType as ApplicationType;
  }


  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Get(":type/stats/")
  async getStats(@Param("type") type?: string): Promise<ApplicationStatistics> {
    let applicationType: ApplicationType | undefined;
    
    if (type) {
      applicationType = this.validateApplicationType(type);
    }
    
    return this.applicationService.getStatistics(applicationType);
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.USER, AccountRoles.JUDGE, AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @UseInterceptors(FileFieldsInterceptor(
    [
      { name: 'resume', maxCount: 1 },
      { name: 'transcript', maxCount: 1 },
    ],
    {
      limits: {
        fileSize: 1000000 * 25,
      },
      fileFilter: (req, file, callback) => {
        const allowedMimes = [
          'application/pdf',
          'application/x-pdf',
          'application/acrobat',
          'applications/vnd.pdf',
          'application/x-download',
          'application/download',
          'text/pdf',
          'text/x-pdf'
        ];
        if (
          !allowedMimes.includes(file.mimetype) ||
          !file.originalname.match(/\.pdf$/i)
        ) {
          return callback(
            new BadRequestException('Only PDF files are allowed. File details: ' + JSON.stringify(file)),
            false,
          );
        }
        callback(null, true);
      },
    },
  ))
  @Post(":type")
  @UsePipes(new ValidationPipe({ transform: true }))
  async createApplication(
    @Param('type') type: string,
    @Body() applicationDTO: ApplicationRequestDTO,
    @UploadedFiles() files: { resume: Express.Multer.File[], transcript: Express.Multer.File[] }
  ): Promise<ApplicationResponseDTO> {
    const applicationType = this.validateApplicationType(type);
    
    const user = await this.accountService.findById(applicationDTO.userId);

    if (!user) {
      throw new Error('User with id ' + applicationDTO.userId + ' not found.');
    }

    const resumeFile = files?.resume?.[0];
    const transcriptFile = files?.transcript?.[0];

    if (transcriptFile) {
      const filename = `/transcripts/${uuidv4()}.pdf`;
      await this.minioService.uploadPdf(filename, transcriptFile.buffer);
      applicationDTO.transcriptUrl = filename;
    }

    if (resumeFile) {
      const filename = `/resumes/${uuidv4()}.pdf`;
      await this.minioService.uploadPdf(filename, resumeFile.buffer);
      applicationDTO.resumeUrl = filename;
    }
    
    const application = await this.applicationService.create(
      applicationDTO, 
      applicationType,
      user
    );

    return this.applicationService.convertToApplicationResponseDTO(
      application,
      user
    );
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Put(':id/accept')
  async acceptApplication(@Param('id') id: string): Promise<ApplicationResponseDTO> {
    const application = await this.applicationService.updateStatus(id, Status.ACCEPTED);
    const user = await this.accountService.findById(application.userId);
    // send to account queue for qr-code creation
    switch (application.type) {
      case ApplicationType.HACKATHON:
        this.applicationProducerService.publishAcceptedHackathonApplication({...application, user});
        return;
      case ApplicationType.JUDGE:
        this.applicationProducerService.publishAcceptedJudgeApplication({...application, user});
        return;
    }
    return this.applicationService.convertToApplicationResponseDTO(
      application,
      user
    );
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Put(':id/deny')
  async denyApplication(@Param('id') id: string): Promise<ApplicationResponseDTO> {
    const application = await this.applicationService.updateStatus(id, Status.DENIED);
    const user = await this.accountService.findById(application.userId);
    switch (application.type) {
      case ApplicationType.HACKATHON:
        this.applicationProducerService.publishDeniedHackathonApplication({...application, user});
        return;
      case ApplicationType.JUDGE:
        this.applicationProducerService.publishDeniedJudgeApplication({...application, user});
        return;
    }

    return this.applicationService.convertToApplicationResponseDTO(
      application,
      user
    );
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Get(':type/list')
  async findAllApplicationsByType(
    @Param('type') type: string,
    @Query("status") status: Status
  ): Promise<ApplicationResponseDTO[]> {
    const applicationType = this.validateApplicationType(type);
    
    const applications = await this.applicationService.findAll({ status, type: applicationType });
    const userIds = applications.map(a => a.userId);
    const users = userIds.length > 0 ? await this.accountService.batchFindById(userIds) : [];
    const userMap = {};

    users.forEach(u => userMap[u.id] = u);

    const applicationResponseDTOs = applications.map(a => {
      return this.applicationService.convertToApplicationResponseDTO(
        a,
        userMap[a.userId],
        false
      );
    });

    return applicationResponseDTOs;
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.USER, AccountRoles.JUDGE, AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Get(':type/user/:id')
  async findApplicationByUserIdAndApplicationType(
    @Param('type') type: string,
    @Param('id') id: string,
    @Req() req: AuthRequest
  ) {
    const applicationType = this.validateApplicationType(type);
    const user = req.user;

    const hasPermission = containsRole(user.user_roles, [AccountRoles.ADMIN, AccountRoles.ORGANIZER]);
    const isTheSameUser = id === user.sub;
    
    if (!isTheSameUser && !hasPermission) {
        throw new Error('no');
    }
    
    const application = await this.applicationService.findByUserIdAndApplicationType(id, applicationType);
    if (!application) {
      return {
        status: Status.NOT_AVAILABLE
      };
    }
    return {
      status: application.status
    };
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.USER, AccountRoles.JUDGE, AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Get('user/:id')
  async findApplicationByUserId(
    @Param('id') id: string,
    @Req() req: AuthRequest
  ): Promise<ApplicationResponseDTO> {
    const currentUser = req.user;

    const hasPermission = containsRole(currentUser.user_roles, [AccountRoles.ADMIN, AccountRoles.ORGANIZER]);
    const isTheSameUser = id === currentUser.sub;

    if (!isTheSameUser && !hasPermission) {
        throw new Error('no');
    }

    const application = await this.applicationService.findByUserId(id);
    const user = await this.accountService.findById(id);
    const defaultApplication: Application = new Application()
    defaultApplication.id = 'NO APPLICATION'

    return this.applicationService.convertToApplicationResponseDTO(
      application && application.id ? application : defaultApplication,
      user
    );
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Get(':id')
  async find(@Param('id', new ParseUUIDPipe()) id: string): Promise<ApplicationResponseDTO> {
    const application = await this.applicationService.findById(id);
    const user = await this.accountService.findById(application.userId);
    application.resumeUrl = application.resumeUrl ? await this.minioService.generatePresignedURL(application.resumeUrl) : '';
    application.transcriptUrl = application.transcriptUrl ? await this.minioService.generatePresignedURL(application.transcriptUrl) : '';
    return this.applicationService.convertToApplicationResponseDTO(
      application,
      user
    );
  }

  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles([AccountRoles.ADMIN, AccountRoles.ORGANIZER])
  @Delete(':id')
  delete(@Param('id') id: string): Promise<DeleteResult> {
    return this.applicationService.delete(id);
  }
}