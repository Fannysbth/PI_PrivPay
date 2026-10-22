import { runService } from '@privpay/common/nest';
import { reconciliationModules } from './reconciliation.module';

void runService({ service: 'reconciliation-service', modules: reconciliationModules() });
