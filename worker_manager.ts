import { ApiKVNamespace } from './api_kv_namespace.ts';
import { Credential, Binding } from './config.ts';
import { RpcChannel } from './rpc_channel.ts';
import { Bodies, PackedRequest, packResponse, addRequestHandlerForReadBodyChunk, packRequest, unpackResponse, makeBodyResolverOverRpc } from './rpc_fetch.ts';
import { addRequestHandlerForRpcKvNamespace } from './rpc_kv_namespace.ts';
import { runScript } from './rpc_script.ts';

export class WorkerManager {
    
    private readonly workerUrl: string;

    private currentWorker?: WorkerInfo;

    private constructor(workerUrl: string) {
        this.workerUrl = workerUrl;
    }

    static async start(): Promise<WorkerManager> {
        // compile the permissionless deno worker (once)
        const result = await Deno.emit('worker.ts', {
            bundle: 'module',
        });
        console.log(result);
        const workerJs = result.files['deno:///bundle.js'];
        const contents = new TextEncoder().encode(workerJs);
        const blob = new Blob([contents]);
        const workerUrl = URL.createObjectURL(blob);
        return new WorkerManager(workerUrl);
    }

    async run(scriptContents: Uint8Array, opts: { bindings: Record<string, Binding>, credential: Credential }): Promise<void> {
        const { bindings, credential } = opts;

        if (this.currentWorker) {
            this.currentWorker.worker.terminate();
            this.currentWorker = undefined;
        }

        // instantiate the permissionless deno worker
        const worker = new Worker(this.workerUrl, { deno: { namespace: false, permissions: 'none' }, type: 'module' });

        // init rpc
        const rpcChannel = new RpcChannel('host', worker.postMessage.bind(worker));
        worker.onerror = e => console.error('onerror', e);
        worker.onmessage = async event => {
            if (await rpcChannel.receiveMessage(event.data)) return;
        };
        worker.onmessageerror = e => console.log('host: onmessageerror', e);

        // make external fetch calls on behalf of the worker
        const bodies = new Bodies();
        rpcChannel.addRequestHandler('fetch', async requestData => {
            const { method, url, headers } = requestData as PackedRequest;
            const res = await fetch(url, { method, headers });
            return packResponse(res, bodies);
        });
        addRequestHandlerForReadBodyChunk(rpcChannel, bodies);

        // handle rpc kv requests, forward to cloudflare api
        const { accountId, apiToken } = credential;
        addRequestHandlerForRpcKvNamespace(rpcChannel, kvNamespace => new ApiKVNamespace(accountId, apiToken, kvNamespace));

        // run the script in the deno worker
        await runScript({ scriptContents, bindings }, rpcChannel);

        this.currentWorker = { worker, rpcChannel, bodies };
    }

    async fetch(request: Request, cfConnectingIp: string): Promise<Response> {
        const { currentWorker } = this;
        if (currentWorker === undefined) throw new Error(`Must call run() before calling fetch()`);
        const { bodies, rpcChannel } = currentWorker;
        const packedRequest = packRequest(request, undefined, bodies);
        packedRequest.headers.push(['cf-connecting-ip', cfConnectingIp]);
        const res = await rpcChannel.sendRequest('fetch', packedRequest, responseData => {
            return unpackResponse(responseData, makeBodyResolverOverRpc(rpcChannel));
        });
        return res;
    }

}

//

interface WorkerInfo {
    readonly rpcChannel: RpcChannel;
    readonly bodies: Bodies;
    readonly worker: Worker;
}