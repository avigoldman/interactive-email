'use strict';

require('dotenv').config();

const _ = require('lodash');
const express = require('express');
const bodyParser = require('body-parser');
const ngrok = require('ngrok');
const SparkPost = require('sparkpost');
const socket = require('socket.io');
const fs = require('fs');
const open = require('open');
const app = express();
const server = require('http').Server(app);
const router = express.Router();
const sparkpost = new SparkPost();
const io = socket(server);
const store = {};
const emailStore = [];

app.use(bodyParser.json());
app.use(express.static('public'));

io.on('connection', function(client) {
  io.emit('store', store);

  _.each(emailStore, (email) => io.emit('email', email));
});

router.use((req, res, next) => {
  res.sendPixel = function() {
    this.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Retry-After': 1,
    //'Cache-Control: post-check=0, pre-check=0',
    'Pragma': 'no-cache'
  });

    this.sendFile(`${__dirname}/public/pixel.png`);
  };


  res.results = function(data) {
    this.send({ results: data });
  };

  next();
});

function serializeMessages(body) {
  return _.map(body, (data) => {
    const rawMessage = _.get(data, 'msys.relay_message');
    const headers = serializeHeaders(rawMessage.content.headers);

    return {
      subject: rawMessage.content.subject,
      headers: headers,
      html: rawMessage.content.html,
      text: rawMessage.content.text,
      to: rawMessage.content.to,
      from: rawMessage.msg_from,
    };
  });
}

function serializeHeaders(rawHeaders) {
  const headers = {};

  _.each(rawHeaders, (rawHeader) => {
    const key = _.toLower(_.first(_.keys(rawHeader)));
    const value = _.first(_.values(rawHeader));
    let currentValue;
    
    if (currentValue = _.get(headers, key)) {
      
      _.set(headers, key, _.isArray(currentValue) ?
                            currentValue.concat([ value ]) :
                            [ currentValue, value ]);
    }
    else {
      _.set(headers, key, value);
    }
  });

  return headers;
}

function extractIdentifiers(message) {
  return _.reduceRight(_.split(_.get(message, 'headers.references', ''), ' '), (results, messageId) => {
    if (_.startsWith(messageId, '<form.')) {
      const [ fullMatch, form, id ] = messageId.match(/form\.([^.]+)\.([^.]+)@/);
      
      return { form, id };
    }

    return results;
  }, {});
}

function receivedInput(form, id, input, value) {
  const storePath = [ form, id, input ];

  if (!_.has(store, storePath)) {
    _.set(store, storePath, value);
  }

  io.emit('store', store);
}

function sendResults(req, res) {
  res.results(_.get(store, _.values(req.params), {}));
}

function sendForm(form, id, address) {
  const formPath = `${__dirname}/forms/${form}.html`;

  if (fs.existsSync(formPath)) {
    return sparkpost.transmissions.send({
      "options": { "transactional": true, },
      "substitution_data": { form, id, "url": app.url },
      "recipients": [ { address } ],
      "content": {
        "from": { "name": "Form", "email": "form@sendmailfor.me" },
        "headers": { "References": "<form.{{form}}.{{id}}@sendmailfor.me>" },
        "subject": "Form",
        "reply_to": "Reply <reply@sendmailfor.me>",
        "html": fs.readFileSync(formPath, 'utf8')
      }
    })
    .then((data) => {
      console.log(`sending ${form} to ${address}`)
      emailStore.push({ form, id, address });
      io.emit('email', { form, id, address });
    });
  }
  else {
    console.log(`${form} doesn't exist`)
  }
}


router.post('/relay', (req, res) => {
  const { body } = req;
  const messages = serializeMessages(body);


  _.each(messages, (message) => {
    if (_.filter(message.to, (email) => _.startsWith(email, 'reply')).length > 0) {
      const { form, id } = extractIdentifiers(message);

      if (!!form && !!id) {
        console.log(`Received reply for ${form}.${id}`);
        receivedInput(form, id, 'reply', message.html || message.text);
      }

      return;
    }

    // send form
    const id = `${message.from.split('@')[0].replace(/\W/g, '')}${Math.ceil(Math.random()*9999)}`;
    sendForm(_.first(message.to).split('@')[0], id, message.from);
  });

  res.sendStatus(200);
});

router.get('/forms/:form/:id/:input/:value', (req, res) => {
  const { params } = req;
  receivedInput(params.form, params.id, params.input, params.value);
  console.log(`Received ${params.input} for ${params.form}.${params.id}`);
  
  res.sendPixel();
});


router.get('/forms/', (req, res) => res.results(store));
router.get('/forms/:form', sendResults);
router.get('/forms/:form/:id', sendResults);


app.use('/api', router);

app.get('/', (req, res) => res.send('test'));


const port = 3000;
ngrok.connect({ addr: port }, (err, url) => {
  app.url = url;
  sparkpost.relayWebhooks.update(process.env.SPARKPOST_RELAY_WEBHOOK, { target: `${url}/api/relay` })
    .then((response) => {
      server.listen(port, () => { console.log(url); });
      open(url);
    })
    .catch((error) => {
      console.log('shit broke', error);
    });
});
