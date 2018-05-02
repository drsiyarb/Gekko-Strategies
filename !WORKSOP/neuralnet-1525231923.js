var convnetjs = require('convnetjs');
var math = require('mathjs');
var moment = require('moment');


var log = require('../core/log.js');

var config = require('../core/util.js').getConfig();
var mode = require('../core/util.js').gekkoMode();

var SMMA = require('./indicators/SMMA.js');

var strategy = {
    ignoreBacktest: false,
    // stores the candles
    priceBuffer: [],
    predictionCount: 0,

    batchsize: 1,
    // no of neurons for the layer
    layer_neurons: 0,
    // activaction function for the first layer, when neurons are > 0
    layer_activation: 'tanh',
    // normalization factor
    scale: 1,
    // stores the last action (buy or sell)
    prevAction: 'wait',
    //stores the price of the last trade (buy/sell)
    prevPrice: 0,
    // counts the number of triggered stoploss events
    stoplossCounter: 0,

    // if you want the bot to hodl instead of selling during a small dip
    // use the hodle_threshold. e.g. 0.95 means the bot won't sell
    // unless the price drops 5% below the last buy price (this.privPrice)
    hodle_threshold: 1,

    // init the strategy
    init: function() {

        this.name = 'Neural Network';
        this.requiredHistory = config.tradingAdvisor.historySize;

        // smooth the input to reduce the noise of the incoming data
        this.SMMA = new SMMA(5);

        let layers = [
            { type: 'input', out_sx: 1, out_sy: 1, out_depth: 1 },
            { type: 'fc', num_neurons: this.layer_neurons, activation: this.layer_activation },
            { type: 'regression', num_neurons: 1 }
        ];

        this.nn = new convnetjs.Net();

        this.nn.makeLayers(layers);
        this.trainer = new convnetjs.SGDTrainer(this.nn, {
            learning_rate: this.settings.learning_rate,
            momentum: this.settings.momentum,
            batch_size: this.batchsize,
            l2_decay: this.settings.decay
        });

        this.addIndicator('stoploss', 'StopLoss', { threshold: this.settings.stoploss_threshold });

        this.hodle_threshold = this.settings.hodle_threshold || 1;
    },

    learn: function() {
        for (let i = 0; i < this.priceBuffer.length - 1; i++) {
            let data = [this.priceBuffer[i]];
            let current_price = [this.priceBuffer[i + 1]];
            let vol = new convnetjs.Vol(data);
            //console.log('pass', i, 'data', data, 'current_price', current_price, 'vol', JSON.stringify(vol));
            this.trainer.train(vol, current_price);
            this.predictionCount++;
        }
    },

    setNormalizeFactor: function(candle) {
        this.scale = Math.pow(10, Math.trunc(candle.high).toString().length + 2);
        log.debug('Set normalization factor to', this.scale);
    },

    update: function(candle) {
        // play with the candle values to finetune this
        this.SMMA.update((candle.high + candle.close + candle.low + candle.vwp) / 4);
        let smmaFast = this.SMMA.result;

        if (1 === this.scale && 1 < candle.high && 0 === this.predictionCount) this.setNormalizeFactor(candle);

        this.priceBuffer.push(smmaFast / this.scale);
        if (2 > this.priceBuffer.length) return;

        for (i = 0; i < 3; ++i)
            this.learn();

        while (this.settings.price_buffer_len < this.priceBuffer.length) this.priceBuffer.shift();
    },

    onTrade: function(event) {

        if ('buy' === event.action) {
            this.indicators.stoploss.long(event.price);
        }
        // store the previous action (buy/sell)
        this.prevAction = event.action;
        // store the price of the previous trade
        this.prevPrice = event.price;

    },

    predictCandle: function() {
        let vol = new convnetjs.Vol(this.priceBuffer);
        let prediction = this.nn.forward(vol);
        return prediction.w[0];
    },

    check: function(candle) {

        if (this.predictionCount > this.settings.min_predictions) {
            let currentPrice = candle.close;

            if (
                'buy' === this.prevAction &&
                this.settings.stoploss_enabled &&
                'stoploss' === this.indicators.stoploss.action
            ) {
                this.stoplossCounter++;
                log.info('>>>>>>>>> Sell - STOPLOSS triggered: ',
                    ((currentPrice - this.prevPrice) / this.prevPrice * 100).toFixed(4) + '%', currentPrice);
                return this.advice('short');
            }

            let prediction = this.predictCandle() * this.scale;
            let meanp = math.mean(prediction, currentPrice);
            let meanAlpha = (meanp - currentPrice) / currentPrice * 100;

            // sell only if the price is higher than the buying price or if the price drops below the threshold
            // a hodle_threshold of 1 will always sell when the NN predicts a drop of the price. play with it!
            let signalSell = currentPrice > this.prevPrice || currentPrice < (this.prevPrice * this.hodle_threshold);

            let signal = meanp < currentPrice;

            if(mode !== 'backtest' || this.ignoreBacktest) {
                log.info('>>>>>>>>> neuralnet '+moment(candle.start).format('YYYY-DD-MM HH:mm')+' <<<<<<<<<');
                log.info( '\t' +
                    'candle:', this.age,
                    'prev action:', this.prevAction
                );
                log.info( '\t' +
                    'price:', currentPrice,
                    'prediction:', prediction.toFixed(0),
                );
                log.info( '\t' +
                    'meanp:', meanp.toFixed(0),
                    'mean alpha:', meanAlpha.toFixed(2) + '%'
                );
                log.info( '\t' +
                    'signalSell:', signalSell,
                    'signal:', signal ? 'Sell' : 'Buy'
                );
            }

            if ('buy' !== this.prevAction && signal === false && meanAlpha > this.settings.threshold_buy) {
                log.info(">>>>>>>>> Buy  - Predicted variation: ", meanAlpha.toFixed(4)+'%', currentPrice);
                return this.advice('long');
            } else if ('sell' !== this.prevAction && signal === true && meanAlpha < this.settings.threshold_sell && signalSell) {
                log.info(">>>>>>>>> Sell - Predicted variation:", meanAlpha.toFixed(4)+'%', currentPrice);
                return this.advice('short');
            }

        }
    },

    end: function() {
        log.debug('Triggered stoploss', this.stoplossCounter, 'times');
    }


};

module.exports = strategy;
