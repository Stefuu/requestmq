const requestmq = require('./requestmq.js');

const connect = () => {
  return requestmq({
    host: process.env.RABBIT_HOST,
    queue: process.env.RABBIT_QUEUE,
    confirmChannel: true,
    prefetch: process.env.RABBIT_PREFETCH || 5
  });
};

const consume = queue => {
  return queue.consume();
};

connect().then(consume);
