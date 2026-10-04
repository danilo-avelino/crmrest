import { Processor } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { JobProcessor } from "../queues/job-processor.js";
import { type InboundJob, QUEUES } from "../queues/queues.module.js";
import { InboundService } from "./inbound.service.js";

@Processor(QUEUES.inbound, { concurrency: 5 })
export class InboundProcessor extends JobProcessor {
  constructor(private readonly inbound: InboundService) {
    super();
  }

  async process(job: Job<InboundJob>): Promise<void> {
    if (job.data.source === "meta") await this.inbound.processMeta(job.data.payload);
  }
}
