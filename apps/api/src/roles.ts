import { Module } from "@nestjs/common";
import { AiAttendanceController } from "./ai/ai-attendance.controller.js";
import { AiAttendantService } from "./ai/ai-attendant.service.js";
import { AiEvaluationService } from "./ai/ai-evaluation.service.js";
import { AiForwardService } from "./ai/ai-forward.service.js";
import { AiReviewService } from "./ai/ai-review.service.js";
import { AiSuggestionService } from "./ai/ai-suggestion.service.js";
import { AiProcessor } from "./ai/ai.processor.js";
import { AnthropicLlmProvider } from "./ai/llm-provider.js";
import { LlmClient } from "./ai/llm.client.js";
import { AgentController } from "./agent/agent.controller.js";
import { AgentService } from "./agent/agent.service.js";
import { TokensModule } from "./auth/tokens.module.js";
import { AutomationsProcessor } from "./automations/automations.processor.js";
import { CourierMenuService } from "./automations/courier-menu.service.js";
import { IfoodAttendanceService } from "./automations/ifood-attendance.service.js";
import { InactivityService } from "./automations/inactivity.service.js";
import { PhoneCollectionService } from "./automations/phone-collection.service.js";
import { ReviewInviteService } from "./automations/review-invite.service.js";
import { SurveyService } from "./automations/survey.service.js";
import { TriageService } from "./automations/triage.service.js";
import { ChannelTokensProcessor, ChannelTokensService } from "./channels/channel-tokens.service.js";
import { ContactDuplicateReviewService } from "./contacts/contact-duplicate-review.service.js";
import { ContactTagsService } from "./contacts/contact-tags.service.js";
import { ContactsController } from "./contacts/contacts.controller.js";
import { ContactsService } from "./contacts/contacts.service.js";
import { ConversationCartController } from "./conversations/conversation-cart.controller.js";
import { ConversationsController } from "./conversations/conversations.controller.js";
import { ConversationsService } from "./conversations/conversations.service.js";
import { IfoodChatController } from "./conversations/ifood-chat.controller.js";
import { IfoodChatService } from "./conversations/ifood-chat.service.js";
import { TeamController } from "./conversations/team.controller.js";
import { CardapioWebProcessor, CardapioWebService } from "./inbound/cardapio-web.service.js";
import { IfoodProcessor, IfoodService } from "./inbound/ifood.service.js";
import { InboundProcessor } from "./inbound/inbound.processor.js";
import { AudioMediaService, TranscriptionProcessor } from "./inbound/audio-media.service.js";
import { InboundService } from "./inbound/inbound.service.js";
import { NeemoProcessor, NeemoService } from "./inbound/neemo.service.js";
import { ENV, type Env } from "./config/env.js";
import { DatabaseService } from "./core/database.service.js";
import { AgentSimulatorService } from "./menu-agent/agent-simulator.service.js";
import { MenuAgentSettingsController } from "./menu-agent/menu-agent-settings.controller.js";
import { ORDER_AGENT_LLM, OrderAgentService } from "./menu-agent/order-agent.service.js";
import { MenuController } from "./menu/menu.controller.js";
import { MenuDescribeController } from "./menu/menu-describe.controller.js";
import { MenuImportController } from "./menu/menu-import.controller.js";
import { MenuImportAiController } from "./menu/menu-import-ai.controller.js";
import { MenuDescribeService } from "./menu/menu-describe.service.js";
import { MenuImportAiExtractor, MenuImportAiProcessor, MenuImportAiService } from "./menu/menu-import-ai.service.js";
import { MenuImportService } from "./menu/menu-import.service.js";
import { AbandonedCartsController } from "./menu/abandoned-carts.controller.js";
import { TagBenefitsController } from "./menu/tag-benefits.controller.js";
import { PlatformPixController } from "./menu/platform-pix.controller.js";
import { MenuImportRequestController, PlatformMenuImportController } from "./menu/menu-import-request.controller.js";
import { MenuImportRequestService } from "./menu/menu-import-request.service.js";
import { MenuPhotoController } from "./menu/menu-photo.controller.js";
import { StorageController } from "./storage/storage.controller.js";
import { MenuStoreController } from "./menu/menu-store.controller.js";
import { MenuService } from "./menu/menu.service.js";
import { StorageService } from "./storage/storage.service.js";
import { FunnelController } from "./funnel/funnel.controller.js";
import { FunnelDashboardController } from "./funnel/funnel-dashboard.controller.js";
import { FunnelService } from "./funnel/funnel.service.js";
import { PublicMenuController } from "./public/public-menu.controller.js";
import { PublicMenuService } from "./public/public-menu.service.js";
import { CustomerAuthService } from "./public/customer-auth.service.js";
import { PublicOrderService } from "./public/public-order.service.js";
import { MetaCapiController } from "./funnel/meta-capi.controller.js";
import { MetaCapiService } from "./funnel/meta-capi.service.js";
import { OrdersController } from "./orders/orders.controller.js";
import { FraudService } from "./orders/fraud.service.js";
import { OrderNoticeService } from "./orders/order-notice.service.js";
import { OrdersService } from "./orders/orders.service.js";
import { OutboundProcessor } from "./outbound/outbound.processor.js";
import { PlatformController } from "./platform/platform.controller.js";
import { RealtimeGateway } from "./realtime/realtime.gateway.js";
import { IfoodReviewsService } from "./reports/ifood-reviews.service.js";
import { ReportsController } from "./reports/reports.controller.js";
import { DemoController } from "./demo/demo.controller.js";
import { DemoService } from "./demo/demo.service.js";
import { ReportsService } from "./reports/reports.service.js";
import { IntegrationsController } from "./settings/integrations.controller.js";
import { IntegrationsService } from "./settings/integrations.service.js";
import { MembersController } from "./settings/members.controller.js";
import { OnboardingController } from "./settings/onboarding.controller.js";
import { OnboardingService } from "./settings/onboarding.service.js";
import { QuickRepliesController } from "./settings/quick-replies.controller.js";
import { SettingsController } from "./settings/settings.controller.js";
import { SettingsService } from "./settings/settings.service.js";
import { SiteController } from "./site/site.controller.js";
import { SuggestionsController } from "./suggestions/suggestions.controller.js";
import { SuggestionsService } from "./suggestions/suggestions.service.js";
import { EvolutionWebhookController } from "./webhooks/evolution-webhook.controller.js";
import { InfinitepayWebhookController } from "./webhooks/infinitepay-webhook.controller.js";
import { AdminNotificationsService } from "./notifications/admin-notifications.service.js";
import { MetaWebhookController } from "./webhooks/meta-webhook.controller.js";
import { StripeWebhookController } from "./webhooks/stripe-webhook.controller.js";
import { PagarmeWebhookController } from "./webhooks/pagarme-webhook.controller.js";

// Um módulo por papel de processo (§3.2); o AppModule monta os do APP_ROLE.

/** api: REST do painel (a autenticação vem do AuthModule). */
@Module({
  controllers: [
    ConversationsController,
    ConversationCartController,
    ContactsController,
    TeamController,
    IfoodChatController,
    SettingsController,
    IntegrationsController,
    QuickRepliesController,
    MembersController,
    ReportsController,
    DemoController,
    OrdersController,
    PlatformController,
    AiAttendanceController,
    OnboardingController,
    AgentController,
    SuggestionsController,
    SiteController,
    MenuController,
    MenuImportController,
    MenuImportRequestController,
    AbandonedCartsController,
    PagarmeWebhookController,
    PlatformPixController,
    TagBenefitsController,
    PlatformMenuImportController,
    MenuDescribeController,
    MenuImportAiController,
    MenuPhotoController,
    StorageController,
    MenuStoreController,
    MenuAgentSettingsController,
    PublicMenuController,
    FunnelController,
    FunnelDashboardController,
    MetaCapiController,
  ],
  providers: [
    ConversationsService,
    IfoodChatService,
    ContactsService,
    SettingsService,
    IntegrationsService,
    ReportsService,
    IfoodReviewsService,
    OrdersService,
    OrderNoticeService,
    FraudService,
    LlmClient,
    AiSuggestionService,
    OnboardingService,
    AgentService,
    SuggestionsService,
    AdminNotificationsService,
    MenuImportService,
    MenuImportRequestService,
    MenuImportAiService,
    MenuDescribeService,
    MenuService,
    StorageService,
    PublicMenuService,
    CustomerAuthService,
    PublicOrderService,
    FunnelService,
    MetaCapiService,
    // "Simular conversa" (C4) roda o agente de pedidos no processo da api, sem enviar nada.
    {
      provide: ORDER_AGENT_LLM,
      inject: [ENV, DatabaseService],
      useFactory: (env: Env, db: DatabaseService) => new AnthropicLlmProvider(env, db),
    },
    OrderAgentService,
    AgentSimulatorService,
    DemoService,
  ],
})
export class ApiRoleModule {}

/** gateway: endpoints públicos dos canais (só valida e enfileira) e os webhooks de pagamento da Stripe e da InfinitePay. */
@Module({ controllers: [MetaWebhookController, EvolutionWebhookController, StripeWebhookController, InfinitepayWebhookController] })
export class GatewayRoleModule {}

/** realtime: Socket.IO para os painéis. */
@Module({ imports: [TokensModule], providers: [RealtimeGateway] })
export class RealtimeRoleModule {}

/** worker: consome as filas. */
@Module({
  providers: [
    InboundService,
    AudioMediaService,
    TranscriptionProcessor,
    InboundProcessor,
    OutboundProcessor,
    PhoneCollectionService,
    SurveyService,
    ReviewInviteService,
    CourierMenuService,
    TriageService,
    IfoodAttendanceService,
    InactivityService,
    ContactTagsService,
    ContactDuplicateReviewService,
    // Varredura dos Pix do cardápio (F6-06): o PublicOrderService cria o pedido do Pix pago.
    PublicMenuService,
    CustomerAuthService,
    FunnelService,
    PublicOrderService,
    MetaCapiService,
    AutomationsProcessor,
    IfoodService,
    IfoodProcessor,
    CardapioWebService,
    CardapioWebProcessor,
    NeemoService,
    NeemoProcessor,
    OrderNoticeService,
    FraudService,
    ChannelTokensService,
    ChannelTokensProcessor,
    LlmClient,
    AiAttendantService,
    AiReviewService,
    AiEvaluationService,
    AiForwardService,
    AiProcessor,
    {
      provide: ORDER_AGENT_LLM,
      inject: [ENV, DatabaseService],
      useFactory: (env: Env, db: DatabaseService) => new AnthropicLlmProvider(env, db),
    },
    OrderAgentService,
    ReportsService,
    AdminNotificationsService,
    StorageService,
    MenuImportAiExtractor,
    MenuImportAiProcessor,
    // Reset diário da conta de demonstração (job demo-reset da fila de automações).
    DemoService,
  ],
})
export class WorkerRoleModule {}
