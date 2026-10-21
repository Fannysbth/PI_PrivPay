import { runService } from '@privpay/common/nest';
import { privacyModules } from './privacy.module';

void runService({ service: 'privacy-service', modules: privacyModules() });
