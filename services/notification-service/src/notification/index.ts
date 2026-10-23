export { HttpPrivacyClient, HttpSmsGateway, type HttpAdapterDeps } from './adapters';
export { ContactRepository, type LogEntry, type SendStatus, type SubjectSql } from './contacts';
export {
  NotificationService,
  TEMPLATES,
  type NotificationServiceDeps,
  type PrivacyClient,
  type RegisterRequest,
  type Registered,
  type SendRequest,
  type SmsGateway,
  type Template,
} from './service';
