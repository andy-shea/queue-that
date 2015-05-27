/* global describe, it, expect, beforeEach, afterEach */

var _ = require('underscore')
var sinon = require('sinon')
var proxyquire = require('proxyquireify-es3')(require)

var QUEUE_POLL_INTERVAL = 100
var ACTIVE_QUEUE_EXPIRE_TIME = 5000
var INITIAL_BACKOFF_TIME = 1000

describe('createQueueThat', function () {
  var createQueueThat
  var createAdapter
  var adapter
  var clock
  var originalNow
  beforeEach(function () {
    // _.now does not play well with sinon
    originalNow = _.now
    _.now = function () {
      return (new Date()).getTime()
    }
    clock = sinon.useFakeTimers(1000)

    adapter = {
      getQueue: sinon.stub().returns([]),
      setQueue: sinon.spy(function (q) {
        adapter.getQueue.returns(q)
      }),
      getErrorCount: sinon.stub().returns(0),
      getBackoffTime: sinon.stub().returns(0),
      setErrorCount: sinon.spy(function (n) {
        adapter.getErrorCount.returns(n)
      }),
      setBackoffTime: sinon.spy(function (t) {
        adapter.getBackoffTime.returns(t)
      }),
      getActiveQueue: sinon.stub(),
      setActiveQueue: sinon.spy(function (id) {
        adapter.getActiveQueue.returns({
          id: id,
          ts: _.now()
        })
      })
    }
    createAdapter = sinon.stub().returns(adapter)
    createQueueThat = sinon.spy(proxyquire('../lib/queue-that', {
      './local-storage-adapter': createAdapter
    }))
  })

  afterEach(function () {
    _.each(createQueueThat.getCalls(), function (call) {
      if (call.returnValue) {
        call.returnValue.destroy()
      }
    })
    clock.restore()
    _.now = originalNow
  })

  it('should require a process option', function () {
    expect(createQueueThat).withArgs({
      process: sinon.stub()
    }).to.not.throwException()
    expect(createQueueThat).withArgs({}).to.throwException()
  })

  describe('queueThat', function () {
    var queueThat
    var options

    beforeEach(function () {
      options = {
        process: sinon.stub()
      }
      queueThat = createQueueThat(options)
    })

    it('should not change the active queue if the active queue hasn\'t expired', function () {
      adapter.getActiveQueue.returns({
        id: '123',
        ts: _.now()
      })
      queueThat('A')
      adapter.getActiveQueue.returns({
        id: '123',
        ts: _.now() - ACTIVE_QUEUE_EXPIRE_TIME + 1
      })
      queueThat('A')
      expect(adapter.setActiveQueue.callCount).to.be(0)
    })

    it('should change the active queue if there is not an active queue defined', function () {
      queueThat('A')
      expect(adapter.setActiveQueue.callCount).to.be(1)
    })

    it('should change the active queue if the active queue has expired', function () {
      adapter.getActiveQueue.returns({
        id: 123,
        ts: _.now() - ACTIVE_QUEUE_EXPIRE_TIME
      })
      queueThat('A')
      expect(adapter.setActiveQueue.callCount).to.be(1)
    })

    it('should continue updating the active timestamp', function () {
      queueThat('A')
      expect(adapter.setActiveQueue.callCount).to.be(1)
      clock.tick(QUEUE_POLL_INTERVAL)
      expect(adapter.setActiveQueue.callCount).to.be(2)
      clock.tick(QUEUE_POLL_INTERVAL)
      expect(adapter.setActiveQueue.callCount).to.be(3)
    })

    it('should not read the queue while tasks are processing', function () {
      queueThat('A')
      expect(adapter.getQueue.callCount).to.be(2)

      clock.tick(QUEUE_POLL_INTERVAL)
      clock.tick(QUEUE_POLL_INTERVAL)
      expect(adapter.getQueue.callCount).to.be(2)

      options.process.getCall(0).args[1]()
      expect(adapter.getQueue.callCount).to.be(3)

      clock.tick(QUEUE_POLL_INTERVAL)
      expect(adapter.getQueue.callCount).to.be(4)
    })

    it('should save tasks to the queue', function () {
      queueThat('A')
      expect(adapter.setQueue.getCall(0).args[0]).to.eql(['A'])
    })

    it('should add tasks to the end of the queue', function () {
      adapter.getQueue.returns(['A'])
      queueThat('B')
      expect(adapter.setQueue.callCount).to.be(1)
      expect(adapter.setQueue.getCall(0).args[0]).to.eql(['A', 'B'])
    })

    it('should process synchronously', function () {
      adapter.setQueue(['A'])
      queueThat('B')
      expect(options.process.callCount).to.be(1)
      expect(options.process.getCall(0).args[0]).to.eql(['A', 'B'])
    })

    it('should not process new tasks added to the active queue until processing has finished ', function () {
      queueThat('A')
      queueThat('B')
      expect(options.process.callCount).to.be(1)
      expect(options.process.getCall(0).args[0]).to.eql(['A'])

      clock.tick(QUEUE_POLL_INTERVAL)

      expect(options.process.callCount).to.be(1)
    })

    it('should process new tasks added to the active queue after processing', function () {
      queueThat('A')
      queueThat('B')
      expect(options.process.callCount).to.be(1)
      expect(options.process.getCall(0).args[0]).to.eql(['A'])

      options.process.getCall(0).args[1]()
      clock.tick(QUEUE_POLL_INTERVAL)

      expect(options.process.callCount).to.be(2)
      expect(options.process.getCall(1).args[0]).to.eql(['B'])
    })

    it('should have a default batch size of 20', function () {
      adapter.setQueue(_.range(50))
      queueThat('A')

      expect(options.process.callCount).to.be(1)
      expect(options.process.getCall(0).args[0].length).to.be(20)
      expect(options.process.getCall(0).args[0][0]).to.be(0)
      expect(options.process.getCall(0).args[0][1]).to.be(1)

      options.process.getCall(0).args[1]()
      clock.tick(QUEUE_POLL_INTERVAL)

      expect(options.process.callCount).to.be(2)
      expect(options.process.getCall(1).args[0].length).to.be(20)

      options.process.getCall(0).args[1]()
      clock.tick(QUEUE_POLL_INTERVAL)

      expect(options.process.callCount).to.be(3)
      expect(options.process.getCall(2).args[0].length).to.be(11)
    })

    it('should use a custom batch size option', function () {
      options.batchSize = 10
      adapter.setQueue(_.range(14))
      queueThat('A')

      expect(options.process.callCount).to.be(1)
      expect(options.process.getCall(0).args[0].length).to.be(10)

      options.process.getCall(0).args[1]()
      clock.tick(QUEUE_POLL_INTERVAL)

      expect(options.process.callCount).to.be(2)
      expect(options.process.getCall(1).args[0].length).to.be(5)
    })

    it('should allow an unlimited batch size option', function () {
      options.batchSize = Infinity
      adapter.setQueue(_.range(1000))
      queueThat('A')

      expect(options.process.callCount).to.be(1)
      expect(options.process.getCall(0).args[0].length).to.be(1001)

      options.process.getCall(0).args[1]()
      clock.tick(QUEUE_POLL_INTERVAL)

      expect(options.process.callCount).to.be(1)
    })

    it('should backoff exponentially on process error', function () {
      adapter.setQueue(_.range(4))
      queueThat('A')

      options.process.getCall(0).args[1]('error')
      clock.tick(INITIAL_BACKOFF_TIME + QUEUE_POLL_INTERVAL)

      expect(options.process.callCount).to.be(2)
      options.process.getCall(1).args[1]('error')

      clock.tick(INITIAL_BACKOFF_TIME + QUEUE_POLL_INTERVAL)
      expect(options.process.callCount).to.be(2)

      clock.tick(INITIAL_BACKOFF_TIME + QUEUE_POLL_INTERVAL)
      expect(options.process.callCount).to.be(3)
    })

    it('should use localStorage as the back off timer', function () {
      adapter.setBackoffTime(3000)
      adapter.setErrorCount(3)
      queueThat('A')

      clock.tick(2999)
      expect(options.process.callCount).to.be(0)

      clock.tick(1)
      expect(options.process.callCount).to.be(1)

      options.process.getCall(0).args[1]('error')
      expect(adapter.setErrorCount.withArgs(4).callCount).to.be(1)
      expect(adapter.setBackoffTime.withArgs(INITIAL_BACKOFF_TIME * Math.pow(2, 3)).callCount).to.be(1)

      clock.tick(INITIAL_BACKOFF_TIME * Math.pow(2, 4) + QUEUE_POLL_INTERVAL)
      expect(options.process.callCount).to.be(2)

      options.process.getCall(1).args[1]()

      expect(adapter.setErrorCount.withArgs(0).callCount).to.be(1)
    })

    it('should not poll backoff when options.process succeeds', function () {
      adapter.setBackoffTime(3000)
      adapter.setErrorCount(1)
      expect(adapter.setBackoffTime.callCount).to.be(1)
      queueThat('A')

      clock.tick(3000 + QUEUE_POLL_INTERVAL)
      expect(adapter.setBackoffTime.callCount).to.be(4)
      options.process.getCall(0).args[1]()

      clock.tick(INITIAL_BACKOFF_TIME * Math.pow(2, 6))
      expect(adapter.setBackoffTime.callCount).to.be(4)
    })
  })
})
