import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Application, ApplicationType } from "./application.entity";
import { DeleteResult, Repository, UpdateResult } from "typeorm";
import { ApplicationRequestDTO, ApplicationResponseDTO, ApplicationStatistics } from "./application.dto";
import { AccountService } from "src/account/account.service";
import { Status } from "./status.enum";
import { MinioService } from "src/minio-s3/minio.service";
import { v4 as uuidv4 } from 'uuid';
import { AccountDTO } from "src/account/account.dto";
import { Question } from "src/question/question.entity";
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

interface Document {
  resume: Express.Multer.File;
  transcript?: Express.Multer.File;
}

@Injectable()
export class ApplicationService {
  maxWordLength = 500;
  maxCharLength = 3000;

  constructor(
    @InjectRepository(Application)
    private applicationRepository: Repository<Application>,
    @InjectPinoLogger(AccountService.name)
    private readonly logger: PinoLogger,
    private accountService: AccountService,
    private minioService: MinioService,
  ) {}

  async findById(id: string): Promise<Application> {
    return await this.applicationRepository.findOne({ where: { id }, relations: { submissions: { question: true }}})
  }

  async findByUserId(id: string): Promise<Application> {
    return await this.applicationRepository.findOne({ where: { userId: id }})
  }

  async findByUserIdAndApplicationType(id: string, type: ApplicationType): Promise<Application> {
    return await this.applicationRepository.findOne({ where: { userId: id, type }, relations: { submissions: { question: true }}})
  }

  async findAll({ type, status } : { type: ApplicationType, status : Status }) : Promise<Application[]> {
    if (!status) {
      return await this.applicationRepository.find({ where: { type}, relations: { submissions: { question: true }}});
    }
    return await this.applicationRepository.find({ where: { type, status }, relations: { submissions: { question: true }}});
  }

async getStatistics(applicationType?: ApplicationType): Promise<ApplicationStatistics> {
  const queryBuilder = this.applicationRepository
    .createQueryBuilder("application")
    .select([
      `SUM(CASE WHEN application.status = 'SUBMITTED' THEN 1 ELSE 0 END) AS submitted`,
      `SUM(CASE WHEN application.status = 'DENIED' THEN 1 ELSE 0 END) AS denied`,
      `SUM(CASE WHEN application.status = 'ACCEPTED' THEN 1 ELSE 0 END) AS accepted`,
    ]);

  if (applicationType) {
    queryBuilder.where("application.type = :type", { type: applicationType });
  }

  return await queryBuilder.getRawOne();
  }

  generateFilename(applicationId: string, userId: string, filetype: 'pdf') {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    return `${applicationId}_${userId}_${timestamp}.${filetype}`;
  }

  isValidResponse(text: string) {
    if (text.length <= this.maxCharLength) {
      return true;
    }

    const len = text.split(/[\s]+/);
    if(len.length <= this.maxWordLength){
        return true;
      }
      
    return false;
  }

  async create(
    applicationDTO: ApplicationRequestDTO,
    type: ApplicationType,
    user: AccountDTO,
  ): Promise<Application> {
    this.logger.info({ msg: "Attempting to create application", applicationDTO });

    const applicationExists = await this.findByUserIdAndApplicationType(user.id, type);
    if (applicationExists) throw new Error('Application already exists');

    applicationDTO.id = uuidv4();

    applicationDTO.submissions.forEach(s => {
      s.userId = user.id;
      s.question = { id: s.questionId } as Question;
      s.applicationType = type; // add this
      if (!s.questionId) throw new Error('Question is null');
      if (!this.isValidResponse(s.answer)) throw new Error('Answer is too long');
    });

    const application = await this.applicationRepository.save({ ...applicationDTO, type, status: Status.SUBMITTED });
    this.logger.info({ msg: "Application created", application });

    return application;
  }

  async updateStatus(id: string, status: Status) : Promise<Application> {
    const application = await this.applicationRepository.findOne(
      { 
        where: { id }, 
        relations: { submissions: true }
      }
    )

    if (!application) {
      throw new Error('Application with id ' + id + ' not found.');
    }

    application.status = status;

    return await this.applicationRepository.save(application)
  }

  delete(id : string) : Promise<DeleteResult> {
    return this.applicationRepository.delete(id);
  }
  

  convertToApplicationResponseDTO(application: Application, user: AccountDTO, includeSubmissions = true): ApplicationResponseDTO {
    const find = (name: string) =>
      application.submissions?.find((s) => s.question?.name === name)?.answer;

    return {
      id: application.id,
      user,
      status: application.status,
      reviewerId: application.reviewerId,
      submissions: application.submissions,
      type: application.type,
      transcriptUrl: application.transcriptUrl,
      resumeUrl: application.resumeUrl,
      firstName: find("firstName"),
      lastName: find("lastName"),
      email: find("email"),
      phoneNumber: find("phoneNumber"),
      school: find("school"),
      discordUsername: find("discordUsername"),
      residence: find("residence"),
    };
  }
}