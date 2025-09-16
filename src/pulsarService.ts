export interface ProducerConfig {
  serviceUrl: string;
  token?: string;
  topic: string;
  verbose?: boolean;
}

export interface ProducerSendOpts {
  payload: string | Buffer;
  key?: string;
  properties?: Record<string, string>;
}

export class PulsarProducerWrapper {
  private client?: Pulsar.Client;
  private producer?: Pulsar.Producer;

  constructor(private cfg: ProducerConfig) {}

  async connect(): Promise<void> {
    const { serviceUrl, token, topic, verbose } = this.cfg;
    this.client = new Pulsar.Client({
      serviceUrl,
      authentication: token ? new Pulsar.AuthenticationToken({ token }) : undefined,
    });
    this.producer = await this.client.createProducer({ topic });
    if (verbose) {
      const sanitizedToken = token ? token.slice(0, 4) + '...' + token.slice(-4) : undefined;
      console.log('[PulsarProducerWrapper] producer options', {
        serviceUrl,
        topic,
        token: sanitizedToken,
      });
    }
  }

  async send(opts: ProducerSendOpts): Promise<{ messageId: string }> {
    if (!this.producer) throw new Error('Producer not connected');
    const msgOpts: any = {
      data: typeof opts.payload === 'string' ? Buffer.from(opts.payload, 'utf8') : opts.payload,
    };
    if (opts.key) msgOpts.partitionKey = opts.key;
    if (opts.properties) msgOpts.properties = opts.properties;
    const msgId = await this.producer.send(msgOpts);
    return { messageId: msgId.toString() };
  }

  async close(): Promise<void> {
    try { await this.producer?.close(); } catch {}
    try { await this.client?.close(); } catch {}
  }
}
import Pulsar from 'pulsar-client';

export interface PulsarMessageInfo {
  id: string;
  publishTime: number;
  eventTime?: number;
  properties: Record<string, string>;
  key?: string;
  data: string; // raw payload as string
  json?: any; // parsed JSON if parseable
}

export interface ConsumerConfig {
  serviceUrl: string; // pulsar broker or proxy URL, e.g. pulsar+ssl://cluster:6651
  token?: string; // auth token (JWT)
  topic: string; // topic full name
  subscription: string; // subscription name
  subscriptionType?: 'Exclusive' | 'Shared' | 'Failover' | 'KeyShared';
  initialPosition?: 'earliest' | 'latest';
  verbose?: boolean;
}

export class PulsarConsumerWrapper {
  private client?: Pulsar.Client;
  private consumer?: Pulsar.Consumer;
  private closed = false;

  constructor(private cfg: ConsumerConfig) {}

  async connect(): Promise<void> {
    const { serviceUrl, token } = this.cfg;
    try {
      this.client = new Pulsar.Client({
        serviceUrl,
        authentication: token ? new Pulsar.AuthenticationToken({ token }) : undefined,
      });

      const subType = this.mapSubscriptionType(this.cfg.subscriptionType);
      const initialPos = this.mapInitialPosition(this.cfg.initialPosition);
      const subscribeOpts: any = {
        topic: this.cfg.topic,
        subscription: this.cfg.subscription,
        subscriptionType: subType,
        ackTimeoutMs: 30000,
      };
      if (initialPos !== undefined) subscribeOpts.subscriptionInitialPosition = initialPos;
      if (this.cfg.verbose) {
        const sanitizedToken = token ? token.slice(0, 4) + '...' + token.slice(-4) : undefined;
        console.log('[PulsarConsumerWrapper] subscribe options', {
          serviceUrl,
          topic: this.cfg.topic,
          subscription: this.cfg.subscription,
          subscriptionType: subType,
          initialPosition: this.cfg.initialPosition,
          token: sanitizedToken,
        });
      }
      this.consumer = await this.client.subscribe(subscribeOpts);
    } catch (e: any) {
      const enriched = new Error(`Failed to create consumer: ${e?.message || e}`);
      (enriched as any).cause = e;
      throw enriched;
    }
  }

  private mapSubscriptionType(t?: ConsumerConfig['subscriptionType']) {
    // pulsar-client ts types may not expose SubscriptionType; use documented numeric mapping.
    // 0: Exclusive, 1: Shared, 2: Failover, 3: KeyShared
    const map: Record<string, number> = {
      exclusive: 0,
      shared: 1,
      failover: 2,
      keyshared: 3,
      'key_shared': 3,
    };
    if (!t) return 0;
    const v = map[t.toLowerCase()];
    if (v === undefined) {
      console.warn(`Unknown subscriptionType '${t}', defaulting to Exclusive`);
      return 0;
    }
    return v;
  }

  private mapInitialPosition(p?: ConsumerConfig['initialPosition']) {
    if (!p) return undefined; // broker default (latest)
    // Node client uses numeric constants: 0 Latest, 1 Earliest (mirroring C++). We'll map.
    const map: Record<string, number> = { latest: 0, earliest: 1 };
    const v = map[p.toLowerCase()];
    if (v === undefined) {
      console.warn(`Unknown initialPosition '${p}', ignoring.`);
      return undefined;
    }
    return v;
  }

  async *messageStream(): AsyncGenerator<PulsarMessageInfo> {
    if (!this.consumer) throw new Error('Consumer not connected');
    while (!this.closed) {
      try {
        const msg = await this.consumer.receive(1000); // 1s timeout loop to allow close check
        if (!msg) continue;
        const dataBuff = msg.getData();
        const str = dataBuff.toString('utf8');
        let json: any | undefined;
        if (str.startsWith('{') || str.startsWith('[')) {
          try { json = JSON.parse(str); } catch { /* ignore */ }
        }
        const info: PulsarMessageInfo = {
          id: msg.getMessageId().toString(),
          publishTime: msg.getPublishTimestamp(),
          eventTime: msg.getEventTimestamp(),
          properties: msg.getProperties() || {},
            key: msg.getPartitionKey() || undefined,
          data: str,
          json,
        };
        yield info;
        this.consumer.acknowledge(msg);
      } catch (e: any) {
        if (e && /Timeout/.test(String(e))) {
          continue; // loop again waiting for new messages
        }
        if (this.closed) break;
        console.error('Pulsar receive error', e);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.consumer?.close(); } catch {}
    try { await this.client?.close(); } catch {}
  }
}
