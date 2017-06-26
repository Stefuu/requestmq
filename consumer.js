'use strict';

const requestmq = require('./requestmq.js');
const https = require('https');
const http = require('http');
const parseUrl = require('url').parse;

const config = require('./package.json').config;
const httpsProxyAgent = require('https-proxy-agent');

let TIME_REQUESTS = 0;
let TOTAL_REQUESTS = 0;

// Configurações do proxy
let proxyConfig = process.env.HTTPS_PROXY || '';

const connect = config => {
  if(config.proxy && config.proxy.url) {
    // sobrescreve a configuração inicial do proxy pela config
    // do utilizador
    proxyConfig = `${config.proxy.url}:${config.proxy.port}`;
  }

  return requestmq(config);
};

const parseContent = content => {
  try {
    return JSON.parse(content.toString());
  } catch(err) {
    console.error('[requestmq] Erro ao executar JSON.parse em mensagem do Rabbit', err);
    return null;
  }
}

const consume = queue => {
  if(queue.channel) {
    return queue.channel.consume(queue.config.queue, message => {
      let data = parseContent(message.content);
      let method = (data.request.method || 'get').toLowerCase();

      request(data)
        .then(() => {
          console.log(`[requestmq] ${data.id}\trabbit ack`);
          queue.channel.ack(message);
        })
        .catch((err) => {
          console.log(`[requestmq] ${data.id}\trabbit nack`, err);
          queue.channel.nack(message);
        });
    });
  } else {
    return Promise.resolve(queue);
  }
};

const post = data => {
  return new Promise((resolve, reject) => {
    // define proxy para conexão post
    if(proxyConfig !== '') {
      data.request['agent'] = new httpsProxyAgent( proxyConfig ); 
    }

    let requestStartTime = new Date();

    let protocol = https;
    if(data.request.protocol == 'http:') {
      protocol = http;
    }

    var req = protocol.request(data.request, function(res) {
      res.setEncoding('utf8');
      let body = '';

      console.log(`[requestmq] ${data.id}\tstatus code: ${res.statusCode}.`);

      res.on('data', chunck => {
        body += chunck;
      });

      res.on('end', () => {
        console.log(`[requestmq] ${data.id}\tbody response: `, body);
        console.log(`[requestmq] ${data.id}\theader response: `, res.headers);

        switch(res.statusCode) {
          case 502:
            reject(body);
            break;

          default:
            resolve(body);
            break;
        }

        // cria média de tempo de request
        TIME_REQUESTS += (new Date() - requestStartTime);
        TOTAL_REQUESTS += 1;
      });
    });

    req.on('error', function(err) {
      console.log(`[requestmq] ${data.id}\terro no request:`, err);

      req.abort();
      reject(err.message);
    });

    if(data.post !== undefined) {
      console.log(`[requestmq] ${data.id}\tpost body`, JSON.stringify(data.post));
      req.write(JSON.stringify(data.post));
    }

    req.end();
  });
};

const request = data => {
  console.log(`[requestmq] ${data.id}\tFaz request ${data.request.method} para ${data.request.hostname}`);

  if(data.request.method == 'POST') {
    return post(data)
            .then(response => {
              process.send({ response: response, data: data });
              return Promise.resolve(response);
            })
            .catch(response => {
              return Promise.reject(response);
            });
  } else {
    //return get(data);
  }
};

process.on('message', m => {
  connect(m).then(consume);
});

setInterval(() => {
  if(TOTAL_REQUESTS) {
    console.log('[requestmq] tempo médio para publicações: %d (requests: %d)', TIME_REQUESTS / TOTAL_REQUESTS, TOTAL_REQUESTS);
  }

  if(TOTAL_REQUESTS > Number.MAX_SAFE_INTEGER / 2) {
    // Zera o valores de estatísticas
    TIME_REQUESTS = 0;
    TOTAL_REQUESTS = 0;
  }
}, 60 * 1000);

module.exports = {
  request
};
