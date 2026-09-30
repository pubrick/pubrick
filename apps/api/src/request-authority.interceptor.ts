import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import {
  type AuthorityRequest,
  REQUEST_AUTHORITY,
  runWithRequestAuthority,
} from "./request-authority";

@Injectable()
export class RequestAuthorityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthorityRequest>();
    const snapshot = request[REQUEST_AUTHORITY];
    // Nest/RxJS handlers are lazy: establish context at subscription, not creation.
    // An unauthenticated request explicitly clears any enclosing context.
    return new Observable((subscriber) => {
      const subscription = runWithRequestAuthority(snapshot, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        }),
      );
      return () => runWithRequestAuthority(snapshot, () => subscription.unsubscribe());
    });
  }
}
