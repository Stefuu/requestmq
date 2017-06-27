'use strict';

const debug = require('debug')('[requestmq]');
const error = require('debug')('[requestmq] Error');
const CPUS = (require('os').cpus().length - 1) || 1;
const fork = require('child_process').fork;
const joinPath = require('path').join;
const consumer = require('./consumer');

const mqueue = require('amqplib');
const MQ_CONN = undefined;
const MQ_CHANNEL = undefined;

// total de requests paralelos para enviar itens para a fila MQ
const MAX_SEND_MQ = CPUS * 15;

// total de mensagens que um worker pode receber
const MAX_WORKER_MESSAGES = 10;

const uniqueId = () => process.hrtime().join('');

class RequestMQ {
  constructor(config) {
    config = config || {};

    this.conn = undefined;
    this.channel = undefined;
    this.consumeCallback = undefined;
    this.canConsume = false;
    this.isConsuming = false;

    // quantidade de requests paralelos que estão sendo feitos
    // enviando itens da fila local para a fila MQ
    this.publish_workers_working = 0;

    // workers de publicação (consumers)
    this.workers = [];

    // Nome da fila no MQ
    this.config = config;

    // Fila de itens que devem ser enviados para a fila MQ
    this.queue = [];

    // Indica se os itens da fila local estão sendo enviados
    // para a fila MQ.
    this.isSendingToQueue = false;

    // Registra evento para remover todos os workers quando a aplicação
    // for encerrada.
    process.on('uncaughtException', err => {
      error('uncaughtException', err);
      //this.stopConsume();
      //process.exit(1);
    });

    process.on('exit', () => {
      debug('exit');
      this.stopConsume();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      debug('SIGINT');
      this.stopConsume();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      debug('SIGTERM');
      this.stopConsume();
      process.exit(0);
    });

    // Faz a conexão, cria o channel e efetua o assert da fila
    return this.connect();
  }

  connect() {
    return mqueue.connect(`amqp://${this.config.host}/`)
      .then(conn => {
        this.conn = conn;

        // registra eventos de erro
        conn.on('error', err => {
          this.conn = undefined;
          this.channel = undefined;

          error('Erro com a conexão rabbit');
          error(err);

          // zera o contador de requests paralelos para o rabbit
          // para que a fila começe novamente
          this.publish_workers_working = 0;
          this.sendToMQ();

          // tenta conectar novamente depois de alguns segundos
          setTimeout(this.connect.bind(this), 10 * 1000);
        });

        return Promise.resolve(conn);
      })
      .then(conn => {
        if(this.config.confirmChannel === true) {
          return this.conn.createConfirmChannel();
        } else {
          return this.conn.createChannel();
        }
      })
      .then(channel => {
        this.channel = channel;

        // define o prefetch
        channel.prefetch(parseInt(this.config.prefetch || 5));

        return channel.assertQueue(this.config.queue).then(ok => {
          return Promise.resolve(this);
        });
      })
      .catch(err => {
        error(`Erro ao conectar em amqp://${this.config.host}`);
        error(err);

        // tenta conectar novamente depois de alguns segundos
        setTimeout(this.connect.bind(this), 10 * 1000);

        return Promise.reject(this);
        //process.exit(1);
      });
  }

  /**
   * Registra um consumidor para a fila.
   * @param {Function} cb Função que será executada ao receber um item para consumo
   */
  consume(cb) {
    if(this.isConsuming === true) {
      return Promise.resolve(this);
    }

    this.consumeCallback = cb;
    this.canConsume = true;
    this.isConsuming = true;

    // cria os workers de consumo
    for(let i = 0; i < CPUS; i++) {
      let worker = {
        id: i,
        busy: false,
        fork: fork(joinPath(__dirname, './consumer.js')),
      };

      worker.fork.send(this.config);

      if(typeof cb == 'function') {
        worker.fork.on('message', cb);
      }

      this.workers.push(worker);
    }

    return Promise.resolve(this);
  }

  stopConsume() {
    this.isConsuming = false;

    if(this.workers.length) {
      // mata todos os workers de consumo, para a publicação
      // dos itens na fila ficarem trabalhando sozinhos
      this.workers = this.workers.filter(w => {
        w.fork.kill('SIGHUP');

        return false;
      });
    }
  }

  /**
   * Envia um sinal de acknowledge para o MQ informado que o item foi
   * consumido com sucesso e que ele pode ser removido da fila.
   * @param {Message} Objeto da mensagem recebida
   */
  ack(item) {
    this.channel.ack(item);
    return Promise.resolve(this);
  }

  /**
   * Adiciona à fila local um item que deve ser enviado para a fila MQ.
   * @param {Object} item
   */
  sendToQueue(item) {
    item.id = uniqueId();

    debug(`${item.id} adicionando item à fila local`);
    debug(`${item.id}`, JSON.stringify(item));
    this.queue.push(item);

    if(this.isSendingToQueue === false || this.sending_mq < MAX_SEND_MQ) {
      this.stopConsume();
      this.sendToMQ();
    }

    return Promise.resolve(this);
  }

  /**
   * Envia para a fila MQ os itens que estão na fila local.
   */
  sendToMQ() {
    if(this.queue.length === 0) {
      this.isSendingToQueue = false;
      this.sending_mq = 0;

      // inicia workers de consumo
      if(this.canConsume === true) {
        this.consume(this.consumeCallback);
      }

      return false;
    }

    // já chegou ao limite de publicações paralelas
    if(this.publish_workers_working >= MAX_SEND_MQ) {
      debug(`máximo de envios (${MAX_SEND_MQ}) paralelos atingido`);
      return false;
    }

    this.isSendintToQueue = true;
    this.publish_workers_working += 1;

    let item = this.queue.pop();
    let data = typeof item === 'string' ? item : JSON.stringify(item);

    debug(`${item.id}\tiniciando envio de item para o rabbit`);

    // se não há conexão com o rabbit, faz a publicação
    // diretamente para o serviço
    if(this.channel === undefined) {
      consumer
        .request(item)
        .then(this.delivered.bind(this))
        .catch(err => {
          this.sendToQueue(item);
          this.delivered();
        })

      return false;
    }

    this.channel.sendToQueue(this.config.queue, new Buffer(data), {}, (err, ok) => {
      if(err) {
        debug(`${item.id}\terro ao enviar item ao rabbitmq`, err);
        this.sendToQueue(item);
      }

      debug(`${item.id}\titem enviado para o rabbitmq com sucesso`);
      this.delivered();
    });
  }

  delivered() {
    this.publish_workers_working -= 1;
    this.sendToMQ();
  }
};

module.exports = (host, config) => new RequestMQ(host, config);
