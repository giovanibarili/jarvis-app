import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "..", "proto", "jarvis.proto");

type MessageHandler = (prompt: string, clientId: string, target?: string) => Promise<string>;

export class GrpcServer {
  private server: grpc.Server;
  private handler: MessageHandler | null = null;

  constructor(port: number) {

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition).jarvis as any;
    this.server = new grpc.Server();
    this.server.addService(proto.Jarvis.service, {
      SendMessage: this.handleSendMessage.bind(this),
    });

    this.start(port);
  }

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  private async handleSendMessage(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const { prompt, client_id, target } = call.request;
    const t0 = Date.now();
    log.info({ prompt: prompt.slice(0, 80), clientId: client_id || "(none)", target: target || "(core)", peer: call.getPeer() }, "gRPC: SendMessage received");

    try {
      let result: string;
      if (!this.handler) throw new Error("No handler configured");
      result = await this.handler(prompt, client_id ?? "", target || undefined);
      log.info({ ms: Date.now() - t0, resultLength: result.length }, "gRPC: SendMessage responded");
      callback(null, { result, session_id: "" });
    } catch (err) {
      log.error({ err, ms: Date.now() - t0 }, "gRPC: SendMessage failed");
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  }

  start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `0.0.0.0:${port ?? config.grpcPort}`,
        grpc.ServerCredentials.createInsecure(),
        (err, port) => {
          if (err) {
            reject(err);
            return;
          }
          log.info({ port }, "gRPC server listening");
          resolve(port);
        }
      );
    });
  }

  stop(): void {
    this.server.forceShutdown();
    log.info("gRPC server stopped");
  }
}
