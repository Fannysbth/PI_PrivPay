import { runService } from '@privpay/common/nest';
import { gatewayModules } from './gateway.module';

void runService({ service: 'gateway', modules: gatewayModules() });
