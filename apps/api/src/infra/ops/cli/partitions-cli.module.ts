import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../../db/database.module';
import { AuditModule } from '../../../modules/audit/audit.module';
import { ConfigModule } from '../../../modules/config/config.module';
import { OutboxModule } from '../../outbox/outbox.module';
import { PartitionMaintenance } from '../partition-maintenance';

/**
 * What `pnpm ops:partitions` starts: the partition maintenance and the configuration it reads.
 * ConfigModule's HolidayService publishes events, so the outbox comes too (found 1405/08/02:
 * without it the command did not start). Nothing here publishes; the worker's daily job keeps
 * its own module.
 */
@Module({
  imports: [DatabaseModule, AuditModule, OutboxModule, ConfigModule],
  providers: [PartitionMaintenance],
})
export class PartitionsCliModule {}
