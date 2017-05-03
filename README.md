# requestmq

## Como usar

Adicionar no `package.json` a dependência `requestmq`:

    "requestmq": "git+https://github.com/gustavopaes/requestmq.git"

No seu projeto, utilizar como um módulo qualquer:

```
const requestmq = require('requestmq');

requestmq({
    host: process.env.RABBIT_HOST,
    queue: process.env.RABBIT_QUEUE,
    confirmChannel: true,
    prefetch: process.env.RABBIT_PREFETCH || 5
})
.consume(item => console.log('Item consumido: ', item))
.sendToQueue({...json com dados do request...});
```

## Formato JSON

O JSON enviado para o RabbitMQ deve seguir um padrão, para que o `requestmq` consiga interpretar
e fazer corretamente o request.

Segue exemplo de JSON que indica um request tipo POST, com dados a serem enviados no body do request:

    {
      request: {
        protocol: 'https:',
        hostname: 'graph.facebook.com',
        path: '/v2.6/me/messages?access_token=XXX',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      },
      post: {
        foo: "dado que será enviado",
        bar: {
            zza: "via header do request"
        }
      }
    }

## Variáveis de ambiente

### Proxy

    HTTPS_PROXY
    url:port para proxy


### RabbitMQ

    RABBIT_HOST
    Host para o RabbitMQ -- com usuário, senha e porta. Não adicionar protocolo.
    Exemplo: admin:admin@rabbitmqhost.intranet
    
    RABBIT_QUEUE
    Nome da fila
    
    RABBIT_PREFETCH
    Prefetch dos workers (default 5)
