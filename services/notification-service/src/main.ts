import { runService } from '@privpay/common/nest';
import { notificationModules } from './notification.module';

void runService({ service: 'notification-service', modules: notificationModules() });
