import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "..", "proto", "jarvis.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition).jarvis as any;

const host = process.argv[2] ?? "localhost:50051";
const prompt = process.argv[3];
const clientId = process.argv[4] ?? "";

if (!prompt) {
  console.error('Usage: tsx src/transport/grpc/client.ts [host:port] "prompt" [clientId]');
  process.exit(1);
}

const client = new proto.Jarvis(host, grpc.credentials.createInsecure());

client.SendMessage({ prompt, client_id: clientId }, (err: any, response: any) => {
  if (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
  console.log(response.result);
});
