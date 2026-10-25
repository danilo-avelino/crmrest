import { ONBOARDING_STEPS, type OnboardingDto, type OnboardingStep, UpdateOnboardingStepRequest } from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { OnboardingService } from "./onboarding.service.js";

/** Assistente de configuração do primeiro acesso (E30). Só o administrador do restaurante. */
@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get(":tenantId")
  get(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<OnboardingDto> {
    return this.onboarding.get(auth, tenantId);
  }

  @Put(":tenantId/steps/:step")
  mark(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("step", new ZodPipe(z.enum(ONBOARDING_STEPS))) step: OnboardingStep,
    @Body(new ZodPipe(UpdateOnboardingStepRequest)) body: UpdateOnboardingStepRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<OnboardingDto> {
    return this.onboarding.mark(auth, tenantId, step, body.mark);
  }

  @Post(":tenantId/opened")
  @HttpCode(200)
  opened(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<OnboardingDto> {
    return this.onboarding.opened(auth, tenantId);
  }
}
