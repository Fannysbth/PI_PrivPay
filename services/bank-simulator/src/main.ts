import { runService } from '@privpay/common/nest';
import { bankSimulatorModules } from './bank-simulator.module';

void runService({ service: 'bank-simulator', modules: bankSimulatorModules() });
