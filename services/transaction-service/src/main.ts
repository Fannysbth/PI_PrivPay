import { runService } from '@privpay/common/nest';
import { transactionModules } from './transaction.module';

void runService({ service: 'transaction-service', modules: transactionModules() });
