import { ErrorHandler, Injectable, NgZone, isDevMode } from "@angular/core";
import { HttpClient } from "@angular/common/http";

interface ErrorMessage {
  message: string;
  type: string;
  timestamp: any;
  stack?: any;
  version?: any;
}

@Injectable()
export class ErrorLoggerHandler extends ErrorHandler {
  private seenList: string[] = [];

  constructor(private zone: NgZone, private http: HttpClient) {
    super();

    window.addEventListener('error', function(event: ErrorEvent) {
      this._log({
        type: event.type,
        message: event.message,
        timestamp: event.timeStamp,
        stack: event.error.stack || event.error
      });
    }.bind(this));

    window.addEventListener('unhandledrejection', function(event) {
      this._logErrorToServer({
        type: event.type,
        message: event.reason.message,
        timestamp: event.timeStamp,
        stack: event.reason.stack
      });
    }.bind(this));

    zone.onError.subscribe(err => this.handleError(err));
  }

  handleError(error) {
    super.handleError(error);
    this._log({
      type: 'Angular Handle Error',
      message: error.message,
      timestamp: Date.now(),
      stack: error.stack,
    });
  }

  private _log(error: ErrorMessage): void {
    if (error.stack) {
      if (error.stack.includes('throwRPCError')) return;
      if (error.stack.includes('ExpressionChangedAfterItHasBeenCheckedError')) return;
      if (error.stack.includes('version.html')) return;
    }

    if (error.message) {
      if (error.message.includes('version.html')) return;
      if (!error.message.includes('ExpressionChangedAfterItHasBeenCheckedError')) return;
    }

    error.version = appVersion;
    this._logErrorToServer(error);
    this._logErrorToLocal(error);
  }

  private _logErrorToServer(error: ErrorMessage): void {
    if (isDevMode()) {
      console.log('Caught Error', error);
      alert(error.message);
    } else {
      if (this.seenList.includes(error.message)) return;
      this.seenList.push(error.message);
      if (error.message) {
        // Haven't logged errors to any server in a long time
        // this.http.post('https://postybirb-error-server.now.sh/log/error', { errorLog: error })
        //   .subscribe(res => console.debug('Error logging success', res), err => console.debug('Error logging failure', err));
      }
    }
  }

  private _logErrorToLocal(error: ErrorMessage): void {
    if (settingsDB.get('localErrorLogging').value()) {
      writeJsonToFile('postybirb_error_logs', error, { flag: 'a' });
    }
  }
}
