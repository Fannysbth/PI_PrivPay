import { runService } from '@privpay/common/nest';
import { smsSimulatorModules } from './sms-simulator.module';

void runService({ service: 'sms-simulator', modules: smsSimulatorModules() });
