import { HttpException, HttpStatus, Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import amqp, { AmqpConnectionManager, ChannelWrapper, Channel } from 'amqp-connection-manager';
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AccountDTO } from "src/account/account.dto";
import { ApplicationResponseDTO } from "src/application/application.dto";

@Injectable()
export class ApplicationProducerService implements OnModuleInit {
  private channelWrapper: ChannelWrapper;
  private connection: AmqpConnectionManager;
  
  @InjectPinoLogger(ApplicationProducerService.name)
  private readonly logger: PinoLogger;

  constructor(private readonly configService: ConfigService) {
    const connection = amqp.connect([this.configService.get<string>('RABBITMQ_URL')]);
    this.channelWrapper = connection.createChannel({
      setup: async (channel: Channel) => {

        const exchange = this.configService.get<string>('APPLICATION_EXCHANGE') || 'application.exchange';
        const queue = this.configService.get<string>('APPLICATION_QUEUE') || 'application.queue';
        const routingKey = 'application.accept';

        // Create exchange
        await channel.assertExchange(exchange, 'topic', {durable : true}); 

        // Create a queue
        await channel.assertQueue(queue, {durable: true});

        // Bind the queue to routing key
        await channel.bindQueue(queue, exchange, routingKey);
        
        this.logger.info(`Exchange, queue, and binding are ready: ${exchange} → ${queue} (${routingKey})`);

      },
     });
  } 

  async onModuleInit() {
    await this.channelWrapper.waitForConnect();
    this.logger.info('ApplicationProducerService connected to RabbitMQ');
  }


  async publishAcceptedHackathonApplication(application: ApplicationResponseDTO) {
    const exchange = this.configService.get<string>('APPLICATION_EXCHANGE') || 'application.exchange';
    const routingKey = 'application.hackathon.accept';
    try {
      await this.channelWrapper.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(application)),
      );
      this.logger.info({ application }, 'Published application.hackathon.accept message');
    } catch (error) {
      this.logger.error({ error }, 'Error publishing application.hackathon.accept message');
    }
  }

  async publishDeniedHackathonApplication(application: ApplicationResponseDTO) {
    const exchange = this.configService.get<string>('APPLICATION_EXCHANGE') || 'application.exchange';
    const routingKey = 'application.hackathon.deny';
    try {
      await this.channelWrapper.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(application)),
      );
      this.logger.info({ application }, 'Published application.hackathon.deny message');
    } catch (error) {
      this.logger.error({ error }, 'Error publishing application.hackathon.deny message');
    }
  }


  async publishAcceptedJudgeApplication(application: ApplicationResponseDTO) {
    const exchange = this.configService.get<string>('APPLICATION_EXCHANGE') || 'application.exchange';
    const routingKey = 'application.judge.accept';
    try {
      await this.channelWrapper.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(application)),
      );
      this.logger.info({ application }, 'Published application.judge.accept message');
    } catch (error) {
      this.logger.error({ error }, 'Error publishing application.judge.accept message');
    }
  }

  async publishDeniedJudgeApplication(application: ApplicationResponseDTO) {
    const exchange = this.configService.get<string>('APPLICATION_EXCHANGE') || 'application.exchange';
    const routingKey = 'application.judge.deny';
    try {
      await this.channelWrapper.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(application)),
      );
      this.logger.info({ application }, 'Published application.judge.deny message');
    } catch (error) {
      this.logger.error({ error }, 'Error publishing application.judge.deny message');
    }
  }

  async publishAcceptedOrganizerApplication(application: ApplicationResponseDTO) {
    const exchange = this.configService.get<string>('APPLICATION_EXCHANGE') || 'application.exchange';
    const routingKey = 'application.organizer.accept';
    try {
      await this.channelWrapper.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(application)),
      );
      this.logger.info({ application }, 'Published application.organizer.accept message');
    } catch (error) {
      this.logger.error({ error }, 'Error publishing application.organizer.accept message');
    }
  }

  async publishDeniedOrganizerApplication(application: ApplicationResponseDTO) {
    const exchange = this.configService.get<string>('APPLICATION_EXCHANGE') || 'application.exchange';
    const routingKey = 'application.organizer.deny';
    try {
      await this.channelWrapper.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(application)),
      );
      this.logger.info({ application }, 'Published application.organizer.deny message');
    } catch (error) {
      this.logger.error({ error }, 'Error publishing application.organizer.deny message');
    }
  }



  // async addCreatedAccountToAccountQueue(responseAccountDTO: AccountDTO) {
  //   try {
  //     await this.channelWrapper.publish(
  //       this.configService.get<string>('ACCOUNT_EXCHANGE'),
  //       'account.create',
  //       Buffer.from(JSON.stringify(responseAccountDTO)),
  //     )
  //     this.logger.info("Sending created account to queue", responseAccountDTO);
  //   } catch (error) {
  //     this.logger.info("Account queue error", error);
  //     throw new HttpException(
  //       'Error adding created account to queue',
  //       HttpStatus.INTERNAL_SERVER_ERROR,
  //     );
  //   }
  // }

  // Queue CALLED
  // APPLICATION ACCEPTED
}
