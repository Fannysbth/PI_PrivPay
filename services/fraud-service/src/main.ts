import { runService } from '@privpay/common/nest';
import { fraudModules } from './fraud.module';

void runService({ service: 'fraud-service', modules: fraudModules() });
