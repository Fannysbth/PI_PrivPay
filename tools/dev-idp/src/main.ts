import { runService } from '@privpay/common/nest';
import { devIdpModules } from './http';

void runService({ service: 'dev-idp', modules: devIdpModules });
