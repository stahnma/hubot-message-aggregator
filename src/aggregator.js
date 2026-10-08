// Description:
//   Listens for thank you reactions, posts the permalink to specified aggregation channel
//
// Dependencies:
//   @slack/web-api
//
// Configuration:
//  HUBOT_AGGREGATION_CHANNEL - the channel to post the permalink to (e.g. general or C1234567890)
//  HUBOT_AGGREGATION_FROM_PRIVATE_CONVERSATIONS - whether to aggregate permalinks from private conversations (default: false)
//  HUBOT_AGGREGATION_PATTERN - the string or regular expression pattern to match for the reaction (default: thank)
//
// Notes:
//  This script is intended to be used only with the Slack adapter. It uses the
//  adapter's Slack Web API client (robot.adapter.client.web), falling back to a
//  client built from HUBOT_SLACK_TOKEN if the adapter does not expose one.
//  Looking up HUBOT_AGGREGATION_CHANNEL by name in private channels needs the
//  groups:read scope. The bot must be a member of the aggregation channel.
//
// Author:
//   stahnma
//
// Category: helper

const handleReaction = (res, robot) => {
    const aggregationChannel = process.env.HUBOT_AGGREGATION_CHANNEL;
    const aggregatorPattern = process.env.HUBOT_AGGREGATION_PATTERN || 'thank';
    const regexFlags = 'i'; // Case insensitive by default

    if (!aggregationChannel) {
        robot.logger.error('HUBOT_AGGREGATION_CHANNEL environment variable is not set.');
        return;
    }

    const channelIdRegex = /^C[0-9A-Z]{9}$/;
    let targetChannel;

    if (channelIdRegex.test(aggregationChannel)) {
        targetChannel = aggregationChannel;
    } else {
        // If not in channel ID format, lookup channel ID by name
        findChannelIdByName(robot, aggregationChannel)
            .then(channelId => {
                if (!channelId) {
                    robot.logger.error(`Cannot find channel with name '${aggregationChannel}'.`);
                    return;
                }
                handleReactionWithChannelId(res, robot, channelId, aggregatorPattern, regexFlags);
            })
            .catch(error => {
                robot.logger.error("Error finding channel ID by name:", error);
            });
        return;
    }

    handleReactionWithChannelId(res, robot, targetChannel, aggregatorPattern, regexFlags);
};

function isSlackAdapter(robot) {
    let adapterName = '';
    if (robot.adapterName != null) {
        adapterName = robot.adapterName;
    } else if (robot.adapter && robot.adapter.name != null) {
        adapterName = robot.adapter.name;
    }
    return /slack/i.test(adapterName);
}

function handleReactionWithChannelId(res, robot, channelId, aggregatorPattern, regexFlags) {
    const message = res.message;
    const reactionRegex = new RegExp(aggregatorPattern, regexFlags);

    if (!reactionRegex.test(message.reaction) || message.type !== 'added') {
        return;
    }

    const item = message.item;
    const channel = item.channel;
    const ts = item.ts;

    // Skip if the message is in the aggregation channel. You don't want this to be recursive.
    if (channel === channelId) {
        robot.logger.info('Skipping posting permalink for message in the aggregation channel.');
        return;
    }

    fetchMessagePermalink(robot, channel, ts)
        .then(permalink => {
            if (permalink) {
                const configAggregateFromPrivate = process.env.HUBOT_AGGREGATION_FROM_PRIVATE_CONVERSATIONS || 'false';
                const aggregateFromPrivate = configAggregateFromPrivate.toLowerCase() === 'true';

                const permalinkKey = `permalink_${permalink.permalink}`;
                const lastPostedTimestamp = robot.brain.get(permalinkKey);

                // Check if the permalink has been posted in the last 24 hours
                const currentTime = new Date().getTime();
                if (lastPostedTimestamp && (currentTime - lastPostedTimestamp < 24 * 60 * 60 * 1000)) {
                    robot.logger.info('Permalink already posted within the last 24 hours', {
                        permalink: permalink.permalink
                    });
                    return;
                }

                // Store the current timestamp for this permalink
                robot.brain.set(permalinkKey, currentTime);

                // If aggregateFromPrivate is false and the conversation is private, return without posting
                if (!aggregateFromPrivate && permalink.isPrivate) {
                    robot.logger.info('Skipping posting permalink from private conversation');
                    return;
                }

                // Post the permalink to the aggregation channel
                robot.messageRoom(channelId, permalink.permalink);
            }
        })
        .catch(error => {
            robot.logger.error("Error fetching the permalink:", error);
            res.send("I encountered an error while fetching the permalink.");
        });
}

function getSlackWebClient(robot) {
    const adapterClient = robot.adapter && robot.adapter.client && robot.adapter.client.web;
    if (adapterClient) {
        return adapterClient;
    }
    const {
        WebClient
    } = require('@slack/web-api');
    return new WebClient(process.env.HUBOT_SLACK_TOKEN);
}

function fetchMessagePermalink(robot, channel, ts) {
    return new Promise((resolve, reject) => {
        const slackWebClient = getSlackWebClient(robot);

        slackWebClient.conversations.info({
            channel: channel
        }).then(response => {
            if (response.ok) {
                const isPrivate = response.channel.is_private;

                slackWebClient.chat.getPermalink({
                    channel: channel,
                    message_ts: ts
                }).then(response => {
                    if (response.ok) {
                        resolve({
                            permalink: response.permalink,
                            isPrivate: isPrivate
                        });
                    } else {
                        reject(new Error('Failed to fetch permalink'));
                    }
                }).catch(error => {
                    reject(error);
                });

            } else {
                reject(new Error('Failed to fetch conversation information'));
            }
        }).catch(error => {
            reject(error);
        });
    });
}

function cleanupBrain(robot) {
    const threshold = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const currentTime = new Date().getTime();

    // Iterate over the brain data and remove outdated entries
    for (const key in robot.brain.data) {
        if (key.startsWith('permalink_')) {
            const timestamp = robot.brain.get(key);
            if (currentTime - timestamp >= threshold) {
                robot.brain.remove(key);
            }
        }
    }
}

// Cache of channel name -> ID, so we don't page through every channel on each reaction
let channelIdCache = {};

async function listChannelsForName(slackWebClient, channelName, types) {
    const matches = c => c.name === channelName && !c.is_archived;
    let cursor;
    do {
        const response = await slackWebClient.conversations.list({
            types: types,
            exclude_archived: true,
            limit: 200,
            cursor: cursor
        });
        if (!response.ok) {
            throw new Error('Failed to fetch channel list');
        }
        const channel = response.channels.find(matches);
        if (channel) {
            return channel.id;
        }
        cursor = response.response_metadata && response.response_metadata.next_cursor;
    } while (cursor);
    return null;
}

async function findChannelIdByName(robot, channelName) {
    if (channelIdCache[channelName]) {
        return channelIdCache[channelName];
    }

    const slackWebClient = getSlackWebClient(robot);

    try {
        let channelId;
        try {
            channelId = await listChannelsForName(slackWebClient, channelName, 'public_channel,private_channel');
        } catch (error) {
            // Without groups:read, Slack rejects the request outright; fall back to public channels only
            if (!(error.data && error.data.error === 'missing_scope')) {
                throw error;
            }
            robot.logger.info('Missing groups:read scope; searching public channels only.');
            channelId = await listChannelsForName(slackWebClient, channelName, 'public_channel');
        }
        if (channelId) {
            channelIdCache[channelName] = channelId;
        }
        return channelId;
    } catch (error) {
        robot.logger.error("Error fetching channel ID by name:", error);
        return null;
    }
}

module.exports = (robot) => {
    if (!isSlackAdapter(robot)) {
        return;
    }

    // Garbage collect outdated brain permalinks
    setInterval(() => cleanupBrain(robot), 24 * 60 * 60 * 1000); // Run every 24 hours

    robot.hearReaction((res) => handleReaction(res, robot));
};

module.exports.handleReaction = handleReaction;
module.exports.handleReactionWithChannelId = handleReactionWithChannelId;
module.exports.cleanupBrain = cleanupBrain;
module.exports.fetchMessagePermalink = fetchMessagePermalink;
module.exports.findChannelIdByName = findChannelIdByName;
