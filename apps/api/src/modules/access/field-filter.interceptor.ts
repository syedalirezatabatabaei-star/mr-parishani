import {
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { hiddenFieldsFor, stripFields } from '@sepehr/contracts';
import { map, type Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../../common/auth/auth.decorators';

/**
 * Field-level restrictions in the output serialization layer (doc 04 §4), for every
 * endpoint, so no handler can forget them. A sensitive field reaches only a caller whose
 * resolved permissions include its class's permission; public and self-service
 * endpoints carry no permissions, so they get none of those fields.
 *
 * The response first goes through JSON exactly as it will be sent, so class instances
 * and toJSON() results are filtered too.
 */
@Injectable()
export class FieldFilterInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return next.handle().pipe(
      map((data: unknown) => {
        if (data === null || typeof data !== 'object') return data;
        if (data instanceof StreamableFile || Buffer.isBuffer(data)) return data;
        const hidden = hiddenFieldsFor(req.access?.permissions ?? new Set());
        return stripFields(JSON.parse(JSON.stringify(data)) as unknown, hidden);
      }),
    );
  }
}
