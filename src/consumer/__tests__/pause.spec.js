const createProducer = require('../../producer')
const createConsumer = require('../index')
const { KafkaJSNonRetriableError } = require('../../errors')

const {
  secureRandom,
  createCluster,
  createTopic,
  newLogger,
  waitForMessages,
  waitForConsumerToJoinGroup,
} = require('testHelpers')

describe('Consumer', () => {
  /**
   * @type {import('../../../types').Consumer}
   */
  let consumer
  let groupId, producer, topics

  beforeEach(async () => {
    topics = [`test-topic-${secureRandom()}`, `test-topic-${secureRandom()}`]
    groupId = `consumer-group-id-${secureRandom()}`

    for (const topic of topics) {
      await createTopic({ topic, partitions: 2 })
    }

    const producerCluster = createCluster()
    producer = createProducer({
      cluster: producerCluster,
      logger: newLogger(),
    })

    const consumerCluster = createCluster()
    consumer = createConsumer({
      cluster: consumerCluster,
      groupId,
      maxWaitTimeInMs: 1,
      maxBytesPerPartition: 180,
      logger: newLogger(),
    })
  })

  afterEach(async () => {
    consumer && (await consumer.disconnect())
    producer && (await producer.disconnect())
  })

  describe('#paused', () => {
    it('returns an empty array if consumer#run has not been called', () => {
      expect(consumer.paused()).toEqual([])
    })
  })

  describe('when pausing', () => {
    it('throws an error if the topic is invalid', () => {
      expect(() => consumer.pause([{ topic: null, partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Invalid topic null'
      )
    })

    it('throws an error if Consumer#run has not been called', () => {
      expect(() => consumer.pause([{ topic: 'foo', partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Consumer group was not initialized, consumer#run must be called first'
      )
    })

    it('pauses the appropriate topic/partition when pausing via the eachMessage callback', async () => {
      await consumer.connect()
      await producer.connect()
      const messages = [0, 0, 1, 0].map(partition => {
        const key = secureRandom()
        return { key: `key-${key}`, value: `value-${key}`, partition }
      })

      for (const topic of topics) {
        await producer.send({ acks: 1, topic, messages: messages.slice(0, 2) })
        await consumer.subscribe({ topic, fromBeginning: true })
      }

      let shouldPause = true
      const messagesConsumed = []
      consumer.run({
        eachMessage: async event => {
          const { topic, message, pause, partition } = event
          if (shouldPause && topic === topics[0] && String(message.key) === messages[1].key) {
            pause()
          }
          messagesConsumed.push({
            topic,
            key: String(message.key),
            value: String(message.value),
            partition,
          })
        },
      })
      await waitForConsumerToJoinGroup(consumer)
      await waitForMessages(messagesConsumed, { number: 3 })
      const [pausedTopic, activeTopic] = topics
      expect(consumer.paused()).toEqual([{ topic: pausedTopic, partitions: [0] }])

      for (const topic of topics) {
        await producer.send({ acks: 1, topic, messages: messages.slice(2) })
      }
      await waitForMessages(messagesConsumed, { number: 6 })

      expect(messagesConsumed).toHaveLength(6)
      expect(messagesConsumed).toContainEqual({ topic: pausedTopic, ...messages[0] }) // partition 0
      expect(messagesConsumed).toContainEqual({ topic: pausedTopic, ...messages[2] }) // partition 1

      expect(messagesConsumed).toContainEqual({ topic: activeTopic, ...messages[0] }) // partition 0
      expect(messagesConsumed).toContainEqual({ topic: activeTopic, ...messages[1] }) // partition 0
      expect(messagesConsumed).toContainEqual({ topic: activeTopic, ...messages[2] }) // partition 1
      expect(messagesConsumed).toContainEqual({ topic: activeTopic, ...messages[3] }) // partition 0

      shouldPause = false
      consumer.resume(consumer.paused())

      await waitForMessages(messagesConsumed, { number: 8 })

      // these messages have to wait until the consumer has resumed
      expect(messagesConsumed).toHaveLength(8)
      expect(messagesConsumed).toContainEqual({ topic: pausedTopic, ...messages[1] }) // partition 0
      expect(messagesConsumed).toContainEqual({ topic: pausedTopic, ...messages[3] }) // partition 0
    })

    it('pauses and resumes after timeout when pausing via the eachMessage callback', async () => {
      await consumer.connect()
      await producer.connect()
      const messages = [0, 0, 0, 0].map(partition => {
        const key = secureRandom()
        return { key: `key-${key}`, value: `value-${key}`, partition }
      })

      for (const topic of topics) {
        await producer.send({ acks: 1, topic, messages: messages })
        await consumer.subscribe({ topic, fromBeginning: true })
      }

      let shouldPause = true
      const messagesConsumed = []
      consumer.run({
        eachMessage: async event => {
          const { topic, message, pause, partition } = event
          if (shouldPause && topic === topics[0] && String(message.key) === messages[1].key) {
            pause(2000) // 2 seconds
          } else if (
            shouldPause &&
            topic === topics[1] &&
            String(message.key) === messages[3].key
          ) {
            pause(3000) // 3 seconds
          }
          messagesConsumed.push({
            topic,
            key: String(message.key),
            value: String(message.value),
            partition,
          })
        },
      })
      await waitForConsumerToJoinGroup(consumer)
      await waitForMessages(messagesConsumed, { number: 4 })
      expect(consumer.paused()).toContainEqual({ topic: topics[0], partitions: [0] })
      expect(consumer.paused()).toContainEqual({ topic: topics[1], partitions: [0] })
      shouldPause = false
      await waitForMessages(messagesConsumed, { number: 8 })
      expect(consumer.paused()).toEqual([])
    })

    it('pauses and resumes after timeout when pausing via the eachBatch callback', async () => {
      await consumer.connect()
      await producer.connect()
      const originalMessages = [0, 0, 0, 1].map(partition => {
        const key = secureRandom()
        return { key: `key-${key}`, value: `value-${key}`, partition }
      })

      for (const topic of topics) {
        await producer.send({ acks: 1, topic, messages: originalMessages })
        await consumer.subscribe({ topic, fromBeginning: true })
      }

      let shouldPause = true
      const messagesConsumed = []
      consumer.run({
        eachBatch: async event => {
          const {
            batch: { topic, messages, partition },
            pause,
            resolveOffset,
            commitOffsetsIfNecessary,
          } = event
          messages.forEach(message => {
            if (
              shouldPause &&
              topic === topics[0] &&
              String(message.key) === originalMessages[1].key
            ) {
              pause(2000) // 2 seconds
            } else if (
              shouldPause &&
              topic === topics[1] &&
              String(message.key) === originalMessages[3].key
            ) {
              pause(3000) // 3 seconds
            }
            messagesConsumed.push({ topic, key: String(message.key), partition })
            resolveOffset(message.offset)
          })
          await commitOffsetsIfNecessary()
        },
      })
      await waitForConsumerToJoinGroup(consumer)
      await waitForMessages(messagesConsumed, { number: 4 })
      expect(consumer.paused()).toContainEqual({ topic: topics[0], partitions: [0] })
      expect(consumer.paused()).toContainEqual({ topic: topics[1], partitions: [1] })
      shouldPause = false
      await waitForMessages(messagesConsumed, { number: 8 })
      expect(consumer.paused()).toEqual([])
      expect(messagesConsumed).toContainEqual({
        topic: topics[0],
        key: String(originalMessages[1].key),
        partition: 0,
      })
      expect(messagesConsumed).toContainEqual({
        topic: topics[1],
        key: String(originalMessages[3].key),
        partition: 1,
      })
    })

    it('does not fetch messages for the paused topic', async () => {
      await consumer.connect()
      await producer.connect()

      const key1 = secureRandom()
      const message1 = { key: `key-${key1}`, value: `value-${key1}`, partition: 0 }
      const key2 = secureRandom()
      const message2 = { key: `key-${key2}`, value: `value-${key2}`, partition: 1 }

      for (const topic of topics) {
        await producer.send({ acks: 1, topic, messages: [message1] })
        await consumer.subscribe({ topic, fromBeginning: true })
      }

      const messagesConsumed = []
      consumer.run({ eachMessage: async event => messagesConsumed.push(event) })

      await waitForConsumerToJoinGroup(consumer)
      await waitForMessages(messagesConsumed, { number: 2 })

      expect(consumer.paused()).toEqual([])
      const [pausedTopic, activeTopic] = topics
      consumer.pause([{ topic: pausedTopic }])

      for (const topic of topics) {
        await producer.send({ acks: 1, topic, messages: [message2] })
      }

      const consumedMessages = await waitForMessages(messagesConsumed, { number: 3 })

      expect(consumedMessages.filter(({ topic }) => topic === pausedTopic)).toEqual([
        expect.objectContaining({
          topic: pausedTopic,
          partition: expect.any(Number),
          message: expect.objectContaining({ offset: '0' }),
        }),
      ])

      const byPartition = (a, b) => a.partition - b.partition
      expect(
        consumedMessages.filter(({ topic }) => topic === activeTopic).sort(byPartition)
      ).toEqual([
        expect.objectContaining({
          topic: activeTopic,
          partition: 0,
          message: expect.objectContaining({ offset: '0' }),
        }),
        expect.objectContaining({
          topic: activeTopic,
          partition: 1,
          message: expect.objectContaining({ offset: '0' }),
        }),
      ])

      expect(consumer.paused()).toEqual([
        {
          topic: pausedTopic,
          partitions: [0, 1],
        },
      ])
    })

    it('does not fetch messages for the paused partitions', async () => {
      await consumer.connect()
      await producer.connect()

      const [topic] = topics
      const partitions = [0, 1]

      const messages = Array(1)
        .fill()
        .map(() => {
          const value = secureRandom()
          return { key: `key-${value}`, value: `value-${value}` }
        })
      const forPartition = partition => message => ({ ...message, partition })

      for (const partition of partitions) {
        await producer.send({ acks: 1, topic, messages: messages.map(forPartition(partition)) })
      }
      await consumer.subscribe({ topic, fromBeginning: true })

      const messagesConsumed = []
      consumer.run({ eachMessage: async event => messagesConsumed.push(event) })

      await waitForConsumerToJoinGroup(consumer)
      await waitForMessages(messagesConsumed, { number: messages.length * partitions.length })

      expect(consumer.paused()).toEqual([])
      const [pausedPartition, activePartition] = partitions
      consumer.pause([{ topic, partitions: [pausedPartition] }])

      for (const partition of partitions) {
        await producer.send({ acks: 1, topic, messages: messages.map(forPartition(partition)) })
      }

      const consumedMessages = await waitForMessages(messagesConsumed, {
        number: messages.length * 3,
      })

      expect(consumedMessages.filter(({ partition }) => partition === pausedPartition)).toEqual(
        messages.map((message, i) =>
          expect.objectContaining({
            topic,
            partition: pausedPartition,
            message: expect.objectContaining({ offset: `${i}` }),
          })
        )
      )

      expect(consumedMessages.filter(({ partition }) => partition !== pausedPartition)).toEqual(
        messages.concat(messages).map((message, i) =>
          expect.objectContaining({
            topic,
            partition: activePartition,
            message: expect.objectContaining({ offset: `${i}` }),
          })
        )
      )

      expect(consumer.paused()).toEqual([
        {
          topic,
          partitions: [pausedPartition],
        },
      ])
    })
  })

  describe('when all topics are paused', () => {
    it('does not fetch messages and wait maxWaitTimeInMs per attempt', async () => {
      const consumerCluster = createCluster()
      consumer = createConsumer({
        cluster: consumerCluster,
        groupId,
        maxWaitTimeInMs: 100,
        maxBytesPerPartition: 180,
        logger: newLogger(),
      })

      await producer.connect()
      await consumer.connect()

      const [topic1, topic2] = topics
      await consumer.subscribe({ topic: topic1, fromBeginning: true })
      await consumer.subscribe({ topic: topic2, fromBeginning: true })

      const eachMessage = jest.fn()
      consumer.run({ eachMessage })
      await waitForConsumerToJoinGroup(consumer)

      consumer.pause([{ topic: topic1 }, { topic: topic2 }])

      const key1 = secureRandom()
      const message1 = { key: `key-${key1}`, value: `value-${key1}`, partition: 0 }

      await producer.send({ acks: 1, topic: topic1, messages: [message1] })
      await producer.send({ acks: 1, topic: topic2, messages: [message1] })

      expect(eachMessage).not.toHaveBeenCalled()
    })
  })

  describe('when resuming', () => {
    it('throws an error if the topic is invalid', () => {
      expect(() => consumer.pause([{ topic: null, partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Invalid topic null'
      )
    })

    it('throws an error if Consumer#run has not been called', () => {
      expect(() => consumer.pause([{ topic: 'foo', partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Consumer group was not initialized, consumer#run must be called first'
      )
    })

    it('resumes fetching from the specified topic', async () => {
      await consumer.connect()
      await producer.connect()

      const key = secureRandom()
      const message = { key: `key-${key}`, value: `value-${key}`, partition: 0 }

      for (const topic of topics) {
        await consumer.subscribe({ topic, fromBeginning: true })
      }

      const messagesConsumed = []
      consumer.run({ eachMessage: async event => messagesConsumed.push(event) })

      const [pausedTopic, activeTopic] = topics
      consumer.pause([{ topic: pausedTopic }])

      await waitForConsumerToJoinGroup(consumer)

      for (const topic of topics) {
        await producer.send({ acks: 1, topic, messages: [message] })
      }

      await waitForMessages(messagesConsumed, { number: 1 })

      consumer.resume([{ topic: pausedTopic }])

      await expect(waitForMessages(messagesConsumed, { number: 2 })).resolves.toEqual([
        expect.objectContaining({
          topic: activeTopic,
          partition: 0,
          message: expect.objectContaining({ offset: '0' }),
        }),
        expect.objectContaining({
          topic: pausedTopic,
          partition: 0,
          message: expect.objectContaining({ offset: '0' }),
        }),
      ])

      expect(consumer.paused()).toEqual([])
    })

    it('resumes fetching from earlier paused partitions', async () => {
      await consumer.connect()
      await producer.connect()

      const [topic] = topics
      const partitions = [0, 1]

      const messages = Array(1)
        .fill()
        .map(() => {
          const value = secureRandom()
          return { key: `key-${value}`, value: `value-${value}` }
        })
      const forPartition = partition => message => ({ ...message, partition })

      for (const partition of partitions) {
        await producer.send({ acks: 1, topic, messages: messages.map(forPartition(partition)) })
      }
      await consumer.subscribe({ topic, fromBeginning: true })

      const messagesConsumed = []
      consumer.run({ eachMessage: async event => messagesConsumed.push(event) })

      await waitForConsumerToJoinGroup(consumer)
      await waitForMessages(messagesConsumed, { number: messages.length * partitions.length })

      const [pausedPartition, activePartition] = partitions
      consumer.pause([{ topic, partitions: [pausedPartition] }])

      for (const partition of partitions) {
        await producer.send({ acks: 1, topic, messages: messages.map(forPartition(partition)) })
      }

      await waitForMessages(messagesConsumed, {
        number: messages.length * 3,
      })

      consumer.resume([{ topic, partitions: [pausedPartition] }])

      const consumedMessages = await waitForMessages(messagesConsumed, {
        number: messages.length * 4,
      })

      expect(consumedMessages.filter(({ partition }) => partition === pausedPartition)).toEqual(
        messages.concat(messages).map((message, i) =>
          expect.objectContaining({
            topic,
            partition: pausedPartition,
            message: expect.objectContaining({ offset: `${i}` }),
          })
        )
      )

      expect(consumedMessages.filter(({ partition }) => partition !== pausedPartition)).toEqual(
        messages.concat(messages).map((message, i) =>
          expect.objectContaining({
            topic,
            partition: activePartition,
            message: expect.objectContaining({ offset: `${i}` }),
          })
        )
      )

      expect(consumer.paused()).toEqual([])
    })
  })
})
