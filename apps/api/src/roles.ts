import { Module } from "@nestjs/common";
import { TokensModule } from "./auth/tokens.module.js";
import { AutomationsProcessor } from "./automations/automations.processor.js";
import { InactivityService } from "./automations/inactivity.service.js";
import { PhoneCollectionService } from "./automations/phone-collection.service.js";
import { SurveyService } from "./automations/survey.service.js";
import { TriageService } from "./automations/triage.service.js";
import { InstagramTokensProcessor, InstagramTokensService } from "./channels/instagram-tokens.service.js";
import { ContactsController } from "./contacts/contacts.controller.js";
import { ContactsService } from "./contacts/contacts.service.js";
import { ConversationsController } from "./conversations/conversations.controller.js";
import { ConversationsService } from "./conversations/conversations.service.js";
import { TeamController } from "./conversations/team.controller.js";
import { CardapioWebProcessor, CardapioWebService } from "./inbound/cardapio-web.service.js";
import { IfoodProcessor, IfoodService } from "./inbound/ifood.service.js";
import { InboundProcessor } from "./inbound/inbound.processor.js";
import { InboundService } from "./inbound/inbound.service.js";
import { OutboundProcessor } from "./outbound/outbound.processor.js";
import { RealtimeGateway } from "./realtime/realtime.gateway.js";
import { ReportsController } from "./reports/reports.controller.js";
import { ReportsService } from "./reports/reports.service.js";
import { IntegrationsController } from "./settings/integrations.controller.js";
import { IntegrationsService } from "./settings/integrations.service.js";
import { MembersController } from "./settings/members.controller.js";
import { QuickRepliesController } from "./settings/quick-replies.controller.js";
import { SettingsController } from "./settings/settings.controller.js";
import { SettingsService } from "./settings/settings.service.js";
import { MetaWebhookController } from "./webhooks/meta-webhook.controller.js";

// Um módulo por papel de processo (§3.2); o AppModule monta os do APP_ROLE.

/** api: REST do painel (a autenticação vem do AuthModule). */
@Module({
  controllers: [
    ConversationsController,
    ContactsController,
    TeamController,
    SettingsController,
    IntegrationsController,
    QuickRepliesController,
    MembersController,
    ReportsController,
  ],
  providers: [ConversationsService, ContactsService, SettingsService, IntegrationsService, ReportsService],
})
export class ApiRoleModule {}

/** gateway: endpoints públicos dos canais; só valida e enfileira. */
@Module({ controllers: [MetaWebhookController] })
export class GatewayRoleModule {}

/** realtime: Socket.IO para os painéis. */
@Module({ imports: [TokensModule], providers: [RealtimeGateway] })
export class RealtimeRoleModule {}

/** worker: consome as filas. */
@Module({
  providers: [
    InboundService,
    InboundProcessor,
    OutboundProcessor,
    PhoneCollectionService,
    SurveyService,
    TriageService,
    InactivityService,
    AutomationsProcessor,
    IfoodService,
    IfoodProcessor,
    CardapioWebService,
    CardapioWebProcessor,
    InstagramTokensService,
    InstagramTokensProcessor,
  ],
})
export class WorkerRoleModule {}
