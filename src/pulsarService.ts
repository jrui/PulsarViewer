import Pulsar from 'pulsar-client';

// Create a simple logger that will work in both Node and Electron contexts
const logger = {
  info: (...args: any[]) => console.log('[PulsarService]', ...args),
  error: (...args: any[]) => console.error('[PulsarService]', ...args),
};

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
    const { serviceUrl, topic, verbose } = this.cfg;
    const token = this.cfg.token?.trim();
    const clientConfig: any = { serviceUrl };
    if (token) {
      clientConfig.authentication = new Pulsar.AuthenticationToken({ token });
      console.log('[PulsarProducerWrapper] Using authentication with token:', token.slice(0, 8) + '...');
    } else {
      console.log('[PulsarProducerWrapper] No token provided, connecting without authentication');
    }
    console.log('[PulsarProducerWrapper] Connecting to:', serviceUrl);
    this.client = new Pulsar.Client(clientConfig);
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
  subscriptionMode?: 'Durable' | 'NonDurable';
  initialPosition?: 'earliest' | 'latest';
  verbose?: boolean;
}

export class PulsarConsumerWrapper {
  private client?: Pulsar.Client;
  private consumer?: Pulsar.Consumer;
  private closed = false;

  constructor(private cfg: ConsumerConfig) {}

  async connect(): Promise<void> {
    const { serviceUrl } = this.cfg;
    const token = this.cfg.token?.trim();
    try {
      const clientConfig: any = { serviceUrl };
      if (token) {
        console.log('[PulsarConsumerWrapper] Token received, length:', token.length);
        console.log('[PulsarConsumerWrapper] Token preview:', token.slice(0, 30) + '...' + token.slice(-30));
        clientConfig.authentication = new Pulsar.AuthenticationToken({ token });
      } else {
        console.log('[PulsarConsumerWrapper] No token provided, connecting without authentication');
      }
      clientConfig.tlsAllowInsecureConnection = true;
      clientConfig.tlsValidateHostname = false;
      console.log('[PulsarConsumerWrapper] Connecting to:', serviceUrl);
      console.log('[PulsarConsumerWrapper] Topic:', this.cfg.topic);
      console.log('[PulsarConsumerWrapper] Subscription:', this.cfg.subscription);
      this.client = new Pulsar.Client(clientConfig);

      const subType = this.mapSubscriptionType(this.cfg.subscriptionType);
      const subMode = this.mapSubscriptionMode(this.cfg.subscriptionMode);
      const initialPos = this.mapInitialPosition(this.cfg.initialPosition);
      const subscribeOpts: any = {
        topic: this.cfg.topic,
        subscription: this.cfg.subscription,
        subscriptionType: subType,
        subscriptionMode: subMode,
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
      logger.error('=== PULSAR CLIENT ERROR DETAILS ===');
      logger.error('Error message:', e?.message);
      logger.error('Error name:', e?.name);
      logger.error('Error code:', e?.code);
      logger.error('Error stack:', e?.stack);
      if (e?.cause) {
        logger.error('Error cause:', e.cause);
      }
      logger.error('Full error object:', JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
      logger.error('=== END ERROR DETAILS ===');
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

  private mapSubscriptionMode(m?: ConsumerConfig['subscriptionMode']) {
    // pulsar-client subscription mode: 0 Durable, 1 NonDurable
    const map: Record<string, number> = {
      durable: 0,
      nondurable: 1,
      'non-durable': 1,
    };
    if (!m) return 1; // default to NonDurable
    const v = map[m.toLowerCase()];
    if (v === undefined) {
      console.warn(`Unknown subscriptionMode '${m}', defaulting to NonDurable`);
      return 1;
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
