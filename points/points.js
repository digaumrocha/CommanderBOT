import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    AttachmentBuilder,
    MessageFlags,
    EmbedBuilder,
    UserSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    RoleSelectMenuBuilder
} from "discord.js";
import fs from "fs";
import path from "path";
import { format } from '@fast-csv/format';

const POINTS_LABEL = "$tarpoints";
const PURPLE_COLOR = 0x8a2be2;

const EPHEMERAL_FLAG = MessageFlags.Ephemeral;

// Store active schedule intervals
const activeSchedules = new Map();

/**
 * @description Tries to fetch the username of a userId.
 */
async function fetchUserTag(client, userId, guild) {
    if (!userId || typeof userId !== 'string' || userId.length < 17 || !/^\d+$/.test(userId)) {
        return `[Unknown ID]`;
    }

    const member = guild?.members.cache.get(userId);
    if (member) return member.user.username;

    try {
        const user = await client.users.fetch(userId);
        return user.username;
    } catch (error) {
        return userId;
    }
}

async function sendDMNotification(client, userId, action, amount, newBalance, reason, giverOrReceiverTag) {
    try {
        const user = await client.users.fetch(userId);

        let title;
        let description;
        let color;

        const POINTS = POINTS_LABEL;

        if (action === 'ADD') {
            title = `💰 ${amount.toLocaleString()} ${POINTS} Added!`;
            description = `You received **${amount.toLocaleString()} ${POINTS}** from **${giverOrReceiverTag}**.\n\nYour new balance is: **${newBalance.toLocaleString()} ${POINTS}**`;
            color = 0x2ecc71;
        } else if (action === 'REMOVE') {
            title = `💸 ${amount.toLocaleString()} ${POINTS} Removed!`;
            description = `**${amount.toLocaleString()} ${POINTS}** was removed from your balance by **${giverOrReceiverTag}**.\n\nYour new balance is: **${newBalance.toLocaleString()} ${POINTS}**`;
            color = 0xe74c3c;
        } else if (action === 'TRANSFER_SENT') {
             title = `📤 ${amount.toLocaleString()} ${POINTS} Transferred!`;
             description = `You successfully sent **${amount.toLocaleString()} ${POINTS}** to **${giverOrReceiverTag}**.\n\nYour new balance is: **${newBalance.toLocaleString()} ${POINTS}**`;
             color = PURPLE_COLOR;
        } else if (action === 'TRANSFER_RECEIVED') {
             title = `📥 ${amount.toLocaleString()} ${POINTS} Received!`;
             description = `You received **${amount.toLocaleString()} ${POINTS}** from **${giverOrReceiverTag}**.\n\nYour new balance is: **${newBalance.toLocaleString()} ${POINTS}**`;
             color = PURPLE_COLOR;
        } else if (action === 'MARKETPLACE_PURCHASE') {
             title = `🛒 Marketplace Purchase!`;
             description = `You spent **${amount.toLocaleString()} ${POINTS}** on the Marketplace.\n\nYour new balance is: **${newBalance.toLocaleString()} ${POINTS}**`;
             color = 0x9b59b6;
        } else {
             return;
        }

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(title)
            .setDescription(description)
            .addFields({ name: 'Reason', value: reason || 'N/A', inline: false })
            .setFooter({ text: 'AstroNADS Bank Notification' })
            .setTimestamp();

        await user.send({ embeds: [embed] }).catch(err => {
            console.warn(`[POINTS] Failed to send DM to user ${userId}: ${err.message}`);
        });
    } catch (error) {
        console.error(`[POINTS] Error in sendDMNotification for user ${userId}: ${error.message}`);
    }
}

/**
 * @description Tries to edit or follow up an interaction.
 */
async function robustReply(interaction, options) {
    const isEphemeral = options.ephemeral;
    const finalOptions = { ...options };
    delete finalOptions.ephemeral;

    if (isEphemeral) {
        finalOptions.flags = finalOptions.flags ? [...finalOptions.flags, MessageFlags.Ephemeral] : [MessageFlags.Ephemeral];
    } else {
        if (finalOptions.flags) {
            finalOptions.flags = finalOptions.flags.filter(f => f !== MessageFlags.Ephemeral);
        }
    }

    if (interaction.replied || interaction.deferred) {
        try {
            return await interaction.editReply(finalOptions);
        } catch (e) {
            return await interaction.followUp({ ...finalOptions, ephemeral: isEphemeral });
        }
    } else {
        try {
            return await interaction.reply({ ...finalOptions, ephemeral: isEphemeral });
        } catch (e) {
            console.warn(`[ROBUST REPLY] Initial reply failed, attempting defer/followUp: ${e.message}`);
            try {
                if (!interaction.deferred) {
                     await interaction.deferReply({ ephemeral: isEphemeral });
                }
                return await interaction.editReply(finalOptions).catch(() => interaction.followUp({ ...finalOptions, ephemeral: isEphemeral }));

            } catch (err) {
                 console.error(`[ROBUST REPLY] FAILED to reply/followUp to interaction: ${err.message}`);
                 return null;
            }
        }
    }
}

async function safeFinalReply(interaction, options) {
    try {
        return await interaction.editReply(options);
    } catch (e) {
        return await interaction.followUp({ ...options, ephemeral: true });
    }
}

async function generateBankEmbed(userId, username, userPoints, client) {
    const BOT_AVATAR = client.user.displayAvatarURL();
    const POINTS = POINTS_LABEL;

    const embed = new EmbedBuilder()
        .setColor(PURPLE_COLOR)
        .setDescription(
            `## 🏦 AstroNADS Bank 🏦\n\n` +
            `**${username}**,\n` +
            `Welcome to your **${POINTS}** Bank\n\n` +
            `Your __**CURRENT BALANCE**__ is:\n` +
            `**${userPoints.toLocaleString()}** ${POINTS}\n\n`
        )
        .setThumbnail(BOT_AVATAR)
        .setFooter({ text: 'AstroNADS Bank | Use the buttons below to interact' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`BANK_HISTORY_${userId}`)
            .setLabel('History')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📜'),
        new ButtonBuilder()
            .setCustomId(`BANK_TRANSFER_START_${userId}`)
            .setLabel('Transfer')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('💸'),
        new ButtonBuilder()
            .setCustomId(`BANK_MARKETPLACE_${userId}`)
            .setLabel('Marketplace')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🛒'),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

// **SLASH COMMANDS**
const commands = [
    new SlashCommandBuilder()
        .setName("starpoints")
        .setDescription(`Manage user ${POINTS_LABEL}`)
        .addSubcommand(sub =>
          sub.setName("add")
            .setDescription(`Add ${POINTS_LABEL} to a user`)
            .addUserOption(opt => opt.setName("user").setDescription("Target user").setRequired(true))
            .addIntegerOption(opt => opt.setName("amount").setDescription(`Amount of ${POINTS_LABEL}`).setRequired(true))
            .addStringOption(opt => opt.setName("reason").setDescription("Reason for the addition").setRequired(false))
        )
        .addSubcommand(sub =>
          sub.setName("remove")
            .setDescription(`Remove ${POINTS_LABEL} from a user`)
            .addUserOption(opt => opt.setName("user").setDescription("Target user").setRequired(true))
            .addIntegerOption(opt => opt.setName("amount").setDescription(`Amount of ${POINTS_LABEL}`).setRequired(true))
            .addStringOption(opt => opt.setName("reason").setDescription("Reason for the removal").setRequired(false))
        )
        .addSubcommand(sub =>
          sub.setName("check")
            .setDescription(`Check your own or another user's ${POINTS_LABEL}`)
            .addUserOption(opt => opt.setName("user").setDescription("Target user (optional)").setRequired(false))
        )
        .addSubcommand(sub =>
          sub.setName("transfer")
            .setDescription(`Transfer ${POINTS_LABEL} to another user`)
            .addUserOption(opt => opt.setName("user").setDescription("User who will receive the points").setRequired(true))
            .addIntegerOption(opt => opt.setName("amount").setDescription(`Amount of ${POINTS_LABEL} to transfer`).setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName("leaderboard")
            .setDescription(`Show users with the most ${POINTS_LABEL}`)
        )
        .addSubcommand(sub =>
          sub.setName("bulk")
            .setDescription(`Give or remove ${POINTS_LABEL} in bulk`)
        )
        .addSubcommand(sub =>
          sub.setName("history")
            .setDescription("Show transaction history for a user")
            .addUserOption(opt => opt.setName("user").setDescription("Target user").setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName("bank")
            .setDescription(`Access the AstroNADS Bank interface.`)
        )
        .addSubcommand(sub =>
            sub.setName("removeallregistry")
            .setDescription("DELETE ALL points and history data (EXTREMELY DANGEROUS)")
        )
        .addSubcommand(sub =>
            sub.setName("schedule")
            .setDescription("Schedule automatic point credits")
        )
        .addSubcommand(sub =>
            sub.setName("listschedules")
            .setDescription("List all active scheduled credits")
        )
        .addSubcommand(sub =>
            sub.setName("cancelschedule")
            .setDescription("Cancel a scheduled credit")
        ),
      new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show all available commands"),
      new SlashCommandBuilder()
        .setName("exportcsv")
        .setDescription(`Export all ${POINTS_LABEL} data as CSV`),
];


// **DATABASE ACCESS FUNCTIONS**
async function getPoints(userId, db) {
    const result = await db.query("SELECT points FROM usuarios WHERE user_id = $1", [userId]);
    return result.rows[0]?.points || 0;
}

async function getHistory(userId, db, limit = 10) {
    const result = await db.query(`
        SELECT * FROM history
        WHERE giverId = $1 OR receiverId = $1
        ORDER BY timestamp DESC
        LIMIT ${limit}
    `, [userId]);
    return result.rows;
}

async function addPoints(giverId, receiverId, amount, reason, logEvent, interaction, db, client) {
    const guild = interaction.guild;
    const receiverTag = await fetchUserTag(client, receiverId, guild);

    const clientDb = await db.connect();
    try {
        await clientDb.query('BEGIN');

        await clientDb.query(`
            INSERT INTO usuarios (user_id, points, username)
            VALUES ($1, $2, $3)
            ON CONFLICT(user_id)
            DO UPDATE
            SET points = usuarios.points + $2, username = $3
        `, [receiverId, amount, receiverTag]);

        await clientDb.query(`
            INSERT INTO history (giverId, receiverId, amount, reason, timestamp)
            VALUES ($1, $2, $3, $4, $5)
        `, [giverId, receiverId, amount, reason ?? "No reason", Date.now()]);

        await clientDb.query('COMMIT');

        const giverTag = await fetchUserTag(client, giverId, guild);
        const newBalance = await getPoints(receiverId, db);

        await sendDMNotification(client, receiverId, 'ADD', amount, newBalance, reason, giverTag);

        logEvent('starpoints', `${amount.toLocaleString()} ${POINTS_LABEL} added to ${receiverTag} by ${giverTag}. Reason: ${reason || 'N/A'}`, interaction);
    } catch (error) {
        await clientDb.query('ROLLBACK');
        throw error;
    } finally {
        clientDb.release();
    }
}

async function removePoints(giverId, receiverId, amount, reason, logEvent, interaction, db, client) {
    const guild = interaction.guild;
    const receiverTag = await fetchUserTag(client, receiverId, guild);

    const clientDb = await db.connect();
    try {
        await clientDb.query('BEGIN');

        await clientDb.query(`
            UPDATE usuarios
            SET points = GREATEST(0, points - $2), username = $3
            WHERE user_id = $1
        `, [receiverId, amount, receiverTag]);

        await clientDb.query(`
            INSERT INTO history (giverId, receiverId, amount, reason, timestamp)
            VALUES ($1, $2, $3, $4, $5)
        `, [giverId, receiverId, -amount, reason ?? "No reason", Date.now()]);

        await clientDb.query('COMMIT');

        const giverTag = await fetchUserTag(client, giverId, guild);
        const newBalance = await getPoints(receiverId, db);

        await sendDMNotification(client, receiverId, 'REMOVE', amount, newBalance, reason, giverTag);

        logEvent('starpoints', `${amount.toLocaleString()} ${POINTS_LABEL} removed from ${receiverTag} by ${giverTag}. Reason: ${reason || 'N/A'}`, interaction);
    } catch (error) {
        await clientDb.query('ROLLBACK');
        throw error;
    } finally {
        clientDb.release();
    }
}

async function transferPoints(senderId, receiverId, amount, interaction, logEvent, db, client) {
    if (senderId === receiverId) {
        return { success: false, message: `❌ You cannot transfer ${POINTS_LABEL} to yourself.` };
    }

    if (amount <= 0) {
        return { success: false, message: "❌ Transfer amount must be positive." };
    }

    const clientDb = await db.connect();

    try {
        await clientDb.query('BEGIN');

        const senderResult = await clientDb.query("SELECT points FROM usuarios WHERE user_id = $1 FOR UPDATE", [senderId]);
        const senderPoints = senderResult.rows[0]?.points || 0;

        if (senderPoints < amount) {
            await clientDb.query('ROLLBACK');
            return { success: false, message: `❌ Insufficient funds. You only have **${senderPoints.toLocaleString()} ${POINTS_LABEL}**.` };
        }

        await clientDb.query(`
            UPDATE usuarios
            SET points = points - $2, username = $3
            WHERE user_id = $1
        `, [senderId, amount, await fetchUserTag(client, senderId, interaction.guild)]);

        await clientDb.query(`
            INSERT INTO usuarios (user_id, points, username)
            VALUES ($1, $2, $3)
            ON CONFLICT(user_id)
            DO UPDATE
            SET points = usuarios.points + $2, username = $3
        `, [receiverId, amount, await fetchUserTag(client, receiverId, interaction.guild)]);

        await clientDb.query(`
            INSERT INTO history (giverId, receiverId, amount, reason, timestamp)
            VALUES ($1, $2, $3, $4, $5)
        `, [senderId, receiverId, -amount, "Transfer sent", Date.now()]);

        await clientDb.query(`
            INSERT INTO history (giverId, receiverId, amount, reason, timestamp)
            VALUES ($1, $2, $3, $4, $5)
        `, [senderId, receiverId, amount, "Transfer received", Date.now()]);

        await clientDb.query('COMMIT');

        const senderTag = await fetchUserTag(client, senderId, interaction.guild);
        const receiverTag = await fetchUserTag(client, receiverId, interaction.guild);

        const senderNewBalance = await getPoints(senderId, db);
        const receiverNewBalance = await getPoints(receiverId, db);

        await sendDMNotification(client, senderId, 'TRANSFER_SENT', amount, senderNewBalance, 'Transfer to ' + receiverTag, receiverTag);
        await sendDMNotification(client, receiverId, 'TRANSFER_RECEIVED', amount, receiverNewBalance, 'Transfer from ' + senderTag, senderTag);

        const message = `${senderTag} transferred ${amount.toLocaleString()} ${POINTS_LABEL} to ${receiverTag}.`;
        logEvent('starpoints', message, interaction);
        return { success: true, message: `✅ Successfully transferred **${amount.toLocaleString()} ${POINTS_LABEL}** to <@${receiverId}>. Your new balance is **${senderNewBalance.toLocaleString()} ${POINTS_LABEL}**.` };
    } catch (error) {
        await clientDb.query('ROLLBACK');
        logEvent('deployment', `Transaction failed for transfer: ${error.message}`, interaction);
        return { success: false, message: `❌ An internal error occurred during the transfer: \`${error.message}\`` };
    } finally {
        clientDb.release();
    }
}

// **DISPLAY FUNCTIONS**

async function displayHistory(interaction, userId, db, client, ephemeral = true) {
    const history = await getHistory(userId, db);
    const userTag = await fetchUserTag(client, userId, interaction.guild);

    if (history.length === 0) {
        return robustReply(interaction, {
            content: `📜 **${userTag}** has no recorded transactions.`,
            ephemeral: ephemeral
        });
    }

    const POINTS = POINTS_LABEL;
    let description = `Showing last ${history.length} transactions for **${userTag}**:\n\n`;

    for (const transaction of history) {
        const isTransfer = transaction.giverid === transaction.receiverid;
        const isReceived = transaction.receiverid === userId && transaction.amount > 0;
        const isSent = transaction.giverid === userId && transaction.amount < 0;

        let type, emoji, otherTag, amountDisplay;

        if (isTransfer) {
            if (transaction.amount < 0) {
                type = 'Sent';
                emoji = '📤';
                otherTag = await fetchUserTag(client, transaction.receiverid, interaction.guild);
                amountDisplay = Math.abs(transaction.amount).toLocaleString();
            } else {
                type = 'Received';
                emoji = '📥';
                otherTag = await fetchUserTag(client, transaction.giverid, interaction.guild);
                amountDisplay = transaction.amount.toLocaleString();
            }
        } else if (isReceived) {
            type = 'Added';
            emoji = '💰';
            otherTag = await fetchUserTag(client, transaction.giverid, interaction.guild);
            amountDisplay = transaction.amount.toLocaleString();
        } else if (isSent) {
            type = 'Removed';
            emoji = '💸';
            otherTag = await fetchUserTag(client, transaction.giverid, interaction.guild);
            amountDisplay = Math.abs(transaction.amount).toLocaleString();
        } else if (transaction.reason === 'Marketplace Purchase' && transaction.amount < 0) {
            type = 'Purchase';
            emoji = '🛒';
            otherTag = 'Marketplace';
            amountDisplay = Math.abs(transaction.amount).toLocaleString();
        } else {
            type = transaction.amount > 0 ? 'Credit' : 'Debit';
            emoji = transaction.amount > 0 ? '➕' : '➖';
            otherTag = await fetchUserTag(client, transaction.giverid, interaction.guild);
            amountDisplay = Math.abs(transaction.amount).toLocaleString();
        }

        const date = new Date(parseInt(transaction.timestamp)).toLocaleDateString('en-US');
        const time = new Date(parseInt(transaction.timestamp)).toLocaleTimeString('en-US');
        const reason = transaction.reason.length > 30 ? transaction.reason.substring(0, 30) + '...' : transaction.reason;

        description += `${emoji} **${amountDisplay}** ${POINTS} ${type} ${type === 'Purchase' ? 'from' : (isSent || isTransfer) ? 'to' : 'from'} **${otherTag}** \`[${date} ${time}]\`\n> *Reason: ${reason}*\n\n`;
    }


    const embed = new EmbedBuilder()
        .setColor(PURPLE_COLOR)
        .setTitle(`📜 Transaction History - ${userTag}`)
        .setDescription(description)
        .setFooter({ text: `AstroNADS Bank History | Total of ${history.length} records shown.` })
        .setTimestamp();

    const options = { embeds: [embed], ephemeral: ephemeral };

    if (interaction.customId && interaction.customId.startsWith('BANK_HISTORY')) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`BANK_BACK_${userId}`)
                .setLabel('Back to Bank')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⬅️')
        );
        options.components = [row];
    }

    return robustReply(interaction, options);
}

async function displayLeaderboard(interaction, db, client) {
    const result = await db.query(`
        SELECT user_id, points, username FROM usuarios
        WHERE points > 0
        ORDER BY points DESC
        LIMIT 10
    `);

    const leaderboard = result.rows;
    const POINTS = POINTS_LABEL;

    if (leaderboard.length === 0) {
        return robustReply(interaction, { content: `The ${POINTS} leaderboard is currently empty.`, ephemeral: true });
    }

    let description = `## 🏆 ${POINTS} Leaderboard 🏆\n\n`;

    for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        const rank = i + 1;
        const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🔹';
        description += `${emoji} **#${rank}** <@${entry.user_id}>: **${entry.points.toLocaleString()}** ${POINTS}\n`;
    }

    const embed = new EmbedBuilder()
        .setColor(PURPLE_COLOR)
        .setDescription(description)
        .setFooter({ text: 'AstroNADS Bank Leaderboard' })
        .setTimestamp();

    return robustReply(interaction, { embeds: [embed], ephemeral: false });
}

// **BANK INTERACTION HANDLER**
async function handleBankInteraction(interaction, db, client, logEvent) {
    const parts = interaction.customId.split('_');
    const userId = parts[parts.length - 1];
    const action = parts[1];

    try {
        if (interaction.user.id !== userId) {
            return robustReply(interaction, { content: `❌ This interaction is not for you. Use **/starpoints bank** to open your own bank.`, ephemeral: true });
        }
        
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }

        const currentPoints = await getPoints(userId, db);
        const username = interaction.user.username;

        if (action === 'BACK') {
            const bankEmbed = await generateBankEmbed(userId, username, currentPoints, client);
            return interaction.editReply(bankEmbed);
        }
        if (action === 'HISTORY') {
            return displayHistory(interaction, userId, db, client, true);
        }
        if (action === 'TRANSFER' && interaction.customId.includes('START')) {
            const row = new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder()
                    .setCustomId(`BANK_TRANSFER_USER_${userId}`)
                    .setPlaceholder('Select a user to transfer points to...')
                    .setMinValues(1)
                    .setMaxValues(1)
            );

            const rowBack = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`BANK_BACK_${userId}`)
                    .setLabel('Cancel / Back to Bank')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('⬅️')
            );

            return interaction.editReply({
                content: `**💸 Transfer Points**\n\n**Current Balance**: **${currentPoints.toLocaleString()}** ${POINTS_LABEL}\n\nSelect the user you wish to send ${POINTS_LABEL} to:`,
                embeds: [],
                components: [row, rowBack]
            });
        }
        if (action === 'MARKETPLACE') {
            if (client.marketplaceCommands?.has('marketplace')) {
                 const marketplaceModule = client.marketplaceCommands.get('marketplace');
                 
                 const fakeInteraction = {
                     deferReply: (o) => Promise.resolve(),
                     editReply: (o) => interaction.editReply(o),
                     followUp: (o) => interaction.followUp(o),
                     user: interaction.user,
                     guild: interaction.guild,
                     options: {
                        getSubcommand: () => 'list',
                        getUser: () => null
                     },
                     replied: interaction.replied,
                     deferred: interaction.deferred,
                     customId: interaction.customId,
                     backToBANKButton: new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`BANK_BACK_${userId}`)
                                .setLabel('Back to Bank')
                                .setStyle(ButtonStyle.Secondary)
                                .setEmoji('⬅️')
                     )
                 };
                 
                 try {
                    return await marketplaceModule.execute(fakeInteraction, db, client, logEvent);
                 } catch (error) {
                    console.error(`[POINTS/BANK] Error executing marketplace module: ${error.message}`);
                    logEvent('deployment', `Fatal error integrating with Marketplace: ${error.message}`, interaction);
                    return interaction.followUp({ 
                        content: `❌ An error occurred while opening the Marketplace. Please notify an admin. \`[${error.message}]\``, 
                        ephemeral: true 
                    });
                 }
            } else {
                 return interaction.editReply({ content: "❌ The Marketplace Module is not loaded or the command is unavailable.", components: [] });
            }
        }
    } catch (error) {
        console.error(`[POINTS/BANK ERROR] Failed to handle interaction ${interaction.customId}: ${error.message}`);
        logEvent('deployment', `Fatal error in handleBankInteraction: ${error.message}`, interaction);
        
        try {
            const errorContent = `❌ An unexpected error occurred while processing your request. Please try again or contact an administrator. \`[${error.message.substring(0, 50)}...]\``;
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorContent, ephemeral: true });
            } else {
                await interaction.reply({ content: errorContent, ephemeral: true });
            }
        } catch (e) {
            console.error(`[POINTS/BANK] Could not send error message to user: ${e.message}`);
        }
    }
}

// **BANK USER SELECT HANDLER**
async function handleBankUserSelect(interaction, db, client, logEvent) {
    const parts = interaction.customId.split('_');
    const userId = parts[parts.length - 1];
    const action = parts[1];
    const subAction = parts[2];

    try {
        if (interaction.user.id !== userId) {
            return robustReply(interaction, { content: "❌ This interaction is not for you.", ephemeral: true });
        }

        if (action === 'TRANSFER' && subAction === 'USER') {
            const receiverId = interaction.values[0];
            const receiverTag = await fetchUserTag(client, receiverId, interaction.guild);
            const currentPoints = await getPoints(userId, db);

            const modal = new ModalBuilder()
                .setCustomId(`BANK_TRANSFER_AMOUNT_MODAL:${userId}_${receiverId}`)
                .setTitle(`💸 Transfer to ${receiverTag}`);

            const amountInput = new TextInputBuilder()
                .setCustomId('transferAmount')
                .setLabel(`Amount of ${POINTS_LABEL} to send (Max: ${currentPoints.toLocaleString()})`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(`Enter amount (e.g., 500)`)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(amountInput));

            await interaction.showModal(modal);

            return;
        }
    } catch (error) {
        console.error(`[POINTS/BANK SELECT ERROR] Failed to handle user select ${interaction.customId}: ${error.message}`);
        logEvent('deployment', `Fatal error in handleBankUserSelect: ${error.message}`, interaction);
        
        try {
            const errorContent = `❌ An unexpected error occurred. Please try again. \`[${error.message.substring(0, 50)}...]\``;
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorContent, ephemeral: true });
            } else {
                console.error(`[POINTS/BANK] Could not send error message as reply may be invalid.`);
            }
        } catch (e) {
            console.error(`[POINTS/BANK] Could not send error message to user: ${e.message}`);
        }
    }
}

// **BANK MODAL SUBMIT HANDLER (TRANSFER AMOUNT)**
async function handleBankModalSubmit(interaction, db, client, logEvent) {
    const [modalInfo, ids] = interaction.customId.split(':');
    const [senderId, receiverId] = ids.split('_');

    if (interaction.user.id !== senderId) {
        return interaction.reply({ content: "❌ This transaction is not for you.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const amountString = interaction.fields.getTextInputValue('transferAmount');
    const amount = parseInt(amountString, 10);

    if (isNaN(amount) || amount <= 0) {
        return safeFinalReply(interaction, { content: `❌ Invalid amount: \`${amountString}\`. Please enter a positive number.`, ephemeral: true });
    }

    if (senderId === receiverId) {
         return safeFinalReply(interaction, { content: `❌ You cannot transfer ${POINTS_LABEL} to yourself.`, ephemeral: true });
    }

    const result = await transferPoints(senderId, receiverId, amount, interaction, logEvent, db, client);

    const currentPoints = await getPoints(senderId, db);
    const username = await fetchUserTag(client, senderId, interaction.guild);

    if (result.success) {
        const bankEmbed = await generateBankEmbed(senderId, username, currentPoints, client);
        return safeFinalReply(interaction, { content: result.message, embeds: bankEmbed.embeds, components: bankEmbed.components });
    } else {
        const bankEmbed = await generateBankEmbed(senderId, username, currentPoints, client);
        return safeFinalReply(interaction, { content: result.message, embeds: bankEmbed.embeds, components: bankEmbed.components });
    }
}

// **SCHEDULE HANDLERS**
async function handleScheduleModalSubmit(interaction, db, client, logEvent) {
    await interaction.deferReply({ ephemeral: true });
    const amount = parseInt(interaction.fields.getTextInputValue('scheduleAmount'), 10);
    const intervalHours = parseInt(interaction.fields.getTextInputValue('scheduleInterval'), 10);

    if (isNaN(amount) || amount <= 0) {
        return interaction.editReply({ content: '❌ Invalid amount. Must be a positive number.' });
    }
    if (isNaN(intervalHours) || intervalHours < 1) {
        return interaction.editReply({ content: '❌ Invalid interval. Must be at least 1 hour.' });
    }

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`scheduleRecipientType:${amount}:${intervalHours}`)
            .setPlaceholder('Select recipient type...')
            .addOptions([
                { label: 'Specific User', value: 'user', description: 'Credit points to one user' },
                { label: 'Role Members', value: 'role', description: 'Credit points to all members of a role' }
            ])
    );

    return interaction.editReply({
        content: `**Schedule Configuration**\n\nAmount: **${amount.toLocaleString()} ${POINTS_LABEL}**\nInterval: **Every ${intervalHours} hour(s)**\n\nSelect the recipient type:`,
        components: [row]
    });
}

async function handleScheduleRecipientTypeSelect(interaction, db, client, logEvent) {
    const [prefix, amount, intervalHours] = interaction.customId.split(':');
    const recipientType = interaction.values[0];
    await interaction.deferUpdate();

    let row;
    if (recipientType === 'user') {
        row = new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId(`scheduleRecipientUser:${amount}:${intervalHours}`)
                .setPlaceholder('Select the user...')
                .setMinValues(1).setMaxValues(1)
        );
    } else {
        row = new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId(`scheduleRecipientRole:${amount}:${intervalHours}`)
                .setPlaceholder('Select the role...')
                .setMinValues(1).setMaxValues(1)
        );
    }

    return interaction.editReply({
        content: `**Schedule Configuration**\n\nAmount: **${amount} ${POINTS_LABEL}**\nInterval: **Every ${intervalHours} hour(s)**\nType: **${recipientType === 'user' ? 'User' : 'Role'}**\n\nSelect the recipient:`,
        components: [row]
    });
}

async function handleScheduleRecipientSelect(interaction, db, client, logEvent) {
    const customIdParts = interaction.customId.split(':');
    const recipientType = customIdParts[0].includes('User') ? 'user' : 'role';
    const amount = parseInt(customIdParts[1], 10);
    const intervalHours = parseInt(customIdParts[2], 10);
    const recipientId = interaction.values[0];
    await interaction.deferUpdate();

    try {
        const result = await db.query(`
            INSERT INTO scheduled_credits (guild_id, recipient_type, recipient_id, amount, interval_hours, created_by, is_active) 
            VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id
        `, [interaction.guild.id, recipientType, recipientId, amount, intervalHours, interaction.user.id]);

        const scheduleId = result.rows[0].id;
        const recipientMention = recipientType === 'user' ? `<@${recipientId}>` : `<@&${recipientId}>`;

        // Start the schedule
        startSchedule(scheduleId, interaction.guild.id, recipientType, recipientId, amount, intervalHours, db, client, logEvent);

        logEvent('starpoints', `Scheduled credit created: ${amount} ${POINTS_LABEL} every ${intervalHours}h to ${recipientType} ${recipientId}`, interaction);

        return interaction.editReply({
            content: `**✅ Schedule Created Successfully!**\n\nSchedule ID: **#${scheduleId}**\nRecipient: ${recipientMention}\nAmount: **${amount.toLocaleString()} ${POINTS_LABEL}**\nInterval: **Every ${intervalHours} hour(s)**\n\n_The schedule is now active and will execute automatically._`,
            components: []
        });
    } catch (error) {
        logEvent('deployment', `Error creating schedule: ${error.message}`, interaction);
        return interaction.editReply({ content: `❌ Error creating schedule: \`${error.message}\``, components: [] });
    }
}

async function handleCancelScheduleSelect(interaction, db, client, logEvent) {
    const scheduleId = parseInt(interaction.values[0], 10);
    await interaction.deferUpdate();

    try {
        await db.query(`UPDATE scheduled_credits SET is_active = false WHERE id = $1`, [scheduleId]);
        if (activeSchedules.has(scheduleId)) {
            clearInterval(activeSchedules.get(scheduleId));
            activeSchedules.delete(scheduleId);
        }
        logEvent('starpoints', `Schedule #${scheduleId} cancelled`, interaction);
        return interaction.editReply({ content: `✅ Schedule #${scheduleId} has been cancelled successfully.`, components: [] });
    } catch (error) {
        logEvent('deployment', `Error cancelling schedule: ${error.message}`, interaction);
        return interaction.editReply({ content: `❌ Error cancelling schedule: \`${error.message}\``, components: [] });
    }
}

// **SCHEDULE EXECUTION LOGIC**
function startSchedule(scheduleId, guildId, recipientType, recipientId, amount, intervalHours, db, client, logEvent) {
    if (activeSchedules.has(scheduleId)) {
        clearInterval(activeSchedules.get(scheduleId));
    }

    const intervalMs = intervalHours * 60 * 60 * 1000;

    const intervalId = setInterval(async () => {
        try {
            const checkResult = await db.query(`SELECT is_active FROM scheduled_credits WHERE id = $1`, [scheduleId]);
            if (!checkResult.rows[0] || !checkResult.rows[0].is_active) {
                clearInterval(intervalId);
                activeSchedules.delete(scheduleId);
                return;
            }

            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                console.error(`[SCHEDULE] Guild ${guildId} not found for schedule ${scheduleId}`);
                return;
            }

            if (recipientType === 'user') {
                const receiverTag = await fetchUserTag(client, recipientId, guild);
                await db.query(`
                    INSERT INTO usuarios (user_id, points, username)
                    VALUES ($1, $2, $3)
                    ON CONFLICT(user_id)
                    DO UPDATE SET points = usuarios.points + $2, username = $3
                `, [recipientId, amount, receiverTag]);

                await db.query(`
                    INSERT INTO history (giverId, receiverId, amount, reason, timestamp)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['SYSTEM', recipientId, amount, `Scheduled credit #${scheduleId}`, Date.now()]);

                const newBalance = await getPoints(recipientId, db);
                await sendDMNotification(client, recipientId, 'ADD', amount, newBalance, `Scheduled credit #${scheduleId}`, 'System');

                console.log(`[SCHEDULE] Credited ${amount} ${POINTS_LABEL} to user ${recipientId}`);
            } else if (recipientType === 'role') {
                const role = guild.roles.cache.get(recipientId);
                if (!role) {
                    console.error(`[SCHEDULE] Role ${recipientId} not found for schedule ${scheduleId}`);
                    return;
                }

                const members = role.members;
                for (const [memberId, member] of members) {
                    const receiverTag = member.user.username;
                    await db.query(`
                        INSERT INTO usuarios (user_id, points, username)
                        VALUES ($1, $2, $3)
                        ON CONFLICT(user_id)
                        DO UPDATE SET points = usuarios.points + $2, username = $3
                    `, [memberId, amount, receiverTag]);

                    await db.query(`
                        INSERT INTO history (giverId, receiverId, amount, reason, timestamp)
                        VALUES ($1, $2, $3, $4, $5)
                    `, ['SYSTEM', memberId, amount, `Scheduled credit #${scheduleId} (Role: ${role.name})`, Date.now()]);

                    const newBalance = await getPoints(memberId, db);
                    await sendDMNotification(client, memberId, 'ADD', amount, newBalance, `Scheduled credit #${scheduleId}`, 'System');
                }

                console.log(`[SCHEDULE] Credited ${amount} ${POINTS_LABEL} to ${members.size} members of role ${role.name}`);
            }

            await db.query(`
                UPDATE scheduled_credits 
                SET last_execution = NOW(), execution_count = execution_count + 1 
                WHERE id = $1
            `, [scheduleId]);

        } catch (error) {
            console.error(`[SCHEDULE] Error executing schedule ${scheduleId}: ${error.message}`);
        }
    }, intervalMs);

    activeSchedules.set(scheduleId, intervalId);
    console.log(`[SCHEDULE] Started schedule ${scheduleId}: ${amount} ${POINTS_LABEL} every ${intervalHours} hour(s)`);
}

async function loadActiveSchedules(db, client, logEvent) {
    try {
        const result = await db.query(`SELECT * FROM scheduled_credits WHERE is_active = true`);
        for (const schedule of result.rows) {
            startSchedule(
                schedule.id,
                schedule.guild_id,
                schedule.recipient_type,
                schedule.recipient_id,
                schedule.amount,
                schedule.interval_hours,
                db,
                client,
                logEvent
            );
        }
        console.log(`[SCHEDULE] Loaded ${result.rows.length} active schedules`);
    } catch (error) {
        console.error(`[SCHEDULE] Error loading schedules: ${error.message}`);
    }
}

// **COMMAND LOGIC**

async function handleLeaderboardCommand(interaction, db, client) {
    return displayLeaderboard(interaction, db, client);
}

async function handleCheckCommand(interaction, db, client) {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const targetId = targetUser.id;
    const targetTag = targetUser.username;
    const currentPoints = await getPoints(targetId, db);
    const POINTS = POINTS_LABEL;

    const embed = new EmbedBuilder()
        .setColor(PURPLE_COLOR)
        .setTitle(`💳 ${targetTag}'s ${POINTS} Balance`)
        .setDescription(`**${targetTag}** currently has **${currentPoints.toLocaleString()}** ${POINTS}.`)
        .setThumbnail(targetUser.displayAvatarURL())
        .setTimestamp();

    return robustReply(interaction, { embeds: [embed], ephemeral: targetId === interaction.user.id });
}

async function handleAdminHistoryCommand(interaction, db, client) {
     const targetUser = interaction.options.getUser("user");
     return displayHistory(interaction, targetUser.id, db, client, true);
}


// **MAIN EXECUTE FUNCTION**
async function execute(interaction, db, client, logEvent) {
    const subcommand = interaction.options.getSubcommand();
    const giverId = interaction.user.id;
    
    // 1. --- PRIORITIZE MODAL COMMANDS (MUST BE SENT AS THE FIRST RESPONSE) ---
    // These must be handled first to prevent the 3-second interaction token expiry.

    if (subcommand === 'bulk') {
        const modal = new ModalBuilder()
            .setCustomId('bulkPointsModal')
            .setTitle('Bulk Points Update');

        const bulkDataInput = new TextInputBuilder()
            .setCustomId('bulkDataInput')
            .setLabel("Enter: [User Tag or ID] [Amount (+/-)]")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("john 2\nmary -6\njoseph 5")
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(bulkDataInput));
        return interaction.showModal(modal);
    }
    
    if (subcommand === 'schedule') {
        const modal = new ModalBuilder()
            .setCustomId('createScheduleModal')
            .setTitle('Create Scheduled Credit');

        const amountInput = new TextInputBuilder()
            .setCustomId('scheduleAmount')
            .setLabel(`Amount of ${POINTS_LABEL} per execution`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 100')
            .setRequired(true);

        const intervalInput = new TextInputBuilder()
            .setCustomId('scheduleInterval')
            .setLabel('Interval in hours')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 24 (for daily)')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(amountInput),
            new ActionRowBuilder().addComponents(intervalInput)
        );

        return interaction.showModal(modal);
    }

    // 2. --- INITIAL DEFERRAL (If not a modal command) ---
    // Only public commands that reply immediately (check, leaderboard) should skip this.
    const isPublicCommand = ['check', 'leaderboard'].includes(subcommand);

    if (!interaction.deferred && !interaction.replied && !isPublicCommand) {
        await interaction.deferReply({ ephemeral: true });
    }


    // 3. --- HANDLE REMAINING COMMANDS ---

    if (subcommand === 'bank') {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }
        
        const userId = interaction.user.id;
        const username = interaction.user.username;
        const currentPoints = await getPoints(userId, db);
        const bankEmbed = await generateBankEmbed(userId, username, currentPoints, client);
        
        return safeFinalReply(interaction, bankEmbed);
    }

    if (subcommand === 'check') {
        return handleCheckCommand(interaction, db, client);
    }

    if (subcommand === 'leaderboard') {
        return handleLeaderboardCommand(interaction, db, client);
    }

    if (subcommand === 'add') {
        const receiverUser = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const reason = interaction.options.getString("reason");
        await addPoints(giverId, receiverUser.id, amount, reason, logEvent, interaction, db, client);
        return safeFinalReply(interaction, { content: `✅ Successfully added **${amount.toLocaleString()} ${POINTS_LABEL}** to <@${receiverUser.id}>. Reason: ${reason || 'N/A'}` });

    } else if (subcommand === 'remove') {
        const receiverUser = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const reason = interaction.options.getString("reason");
        await removePoints(giverId, receiverUser.id, amount, reason, logEvent, interaction, db, client);
        return safeFinalReply(interaction, { content: `✅ Successfully removed **${amount.toLocaleString()} ${POINTS_LABEL}** from <@${receiverUser.id}>. Reason: ${reason || 'N/A'}` });

    } else if (subcommand === 'transfer') {
        const receiverUser = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const result = await transferPoints(giverId, receiverUser.id, amount, interaction, logEvent, db, client);
        return safeFinalReply(interaction, { content: result.message });

    } else if (subcommand === 'history') {
         return handleAdminHistoryCommand(interaction, db, client);
    } else if (subcommand === 'removeallregistry') {
        return handleRemoveAllRegistry(interaction, db, logEvent);
    } else if (subcommand === 'listschedules') {
        const result = await db.query(`
            SELECT * FROM scheduled_credits 
            WHERE guild_id = $1 AND is_active = true 
            ORDER BY id DESC
        `, [interaction.guild.id]);

        if (result.rows.length === 0) {
            return safeFinalReply(interaction, { content: '📋 No active scheduled credits found.' });
        }

        let description = '**Active Scheduled Credits:**\n\n';
        for (const schedule of result.rows) {
            const recipientMention = schedule.recipient_type === 'user' 
                ? `<@${schedule.recipient_id}>` 
                : `<@&${schedule.recipient_id}>`;
            description += `**Schedule #${schedule.id}**\n`;
            description += `> Recipient: ${recipientMention} (${schedule.recipient_type})\n`;
            description += `> Amount: **${schedule.amount.toLocaleString()} ${POINTS_LABEL}**\n`;
            description += `> Interval: Every **${schedule.interval_hours} hour(s)**\n`;
            description += `> Executions: ${schedule.execution_count || 0}\n`;
            description += `> Last Run: ${schedule.last_execution ? new Date(schedule.last_execution).toLocaleString() : 'Never'}\n\n`;
        }

        const embed = new EmbedBuilder()
            .setColor(PURPLE_COLOR)
            .setTitle('📋 Scheduled Credits')
            .setDescription(description)
            .setFooter({ text: `Total: ${result.rows.length} active schedule(s)` })
            .setTimestamp();

        return safeFinalReply(interaction, { embeds: [embed] });
    } else if (subcommand === 'cancelschedule') {
        const result = await db.query(`
            SELECT id, recipient_type, recipient_id, amount, interval_hours 
            FROM scheduled_credits 
            WHERE guild_id = $1 AND is_active = true 
            ORDER BY id DESC
        `, [interaction.guild.id]);

        if (result.rows.length === 0) {
            return safeFinalReply(interaction, { content: '❌ No active schedules to cancel.' });
        }

        const options = result.rows.map(schedule => {
            const recipientMention = schedule.recipient_type === 'user' 
                ? `User` 
                : `Role`;
            return {
                label: `Schedule #${schedule.id}`,
                description: `${schedule.amount} ${POINTS_LABEL} every ${schedule.interval_hours}h to ${recipientMention}`,
                value: schedule.id.toString()
            };
        });

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('cancelScheduleSelect')
                .setPlaceholder('Select a schedule to cancel...')
                .addOptions(options.slice(0, 25))
        );

        return safeFinalReply(interaction, {
            content: '**Cancel Scheduled Credit**\n\nSelect the schedule you want to cancel:',
            components: [row]
        });
    }
}

async function handleExportCSV(interaction, db, client) {
    await interaction.deferReply({ ephemeral: true });

    const clientDb = await db.connect();
    try {
        const usersResult = await clientDb.query("SELECT user_id, points, username FROM usuarios ORDER BY points DESC");
        const historyResult = await clientDb.query("SELECT * FROM history ORDER BY timestamp DESC");

        const userData = usersResult.rows.map(row => ({
            'User ID': row.user_id,
            'Username': row.username,
            '$tarpoints': row.points.toLocaleString()
        }));

        const historyData = historyResult.rows.map(row => ({
            'Transaction ID': row.id,
            'Giver ID': row.giverid,
            'Receiver ID': row.receiverid,
            'Amount': row.amount.toLocaleString(),
            'Reason': row.reason,
            'Timestamp': new Date(parseInt(row.timestamp)).toISOString()
        }));

        const exportPath = path.join(process.cwd(), 'temp', `starpoints_export_${Date.now()}.csv`);
        const directory = path.dirname(exportPath);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        let csvContent = "";
        const userStream = format({ headers: true });
        userStream.on('data', chunk => csvContent += chunk.toString());
        userStream.write({ '---': '---', '---': '---', '---': '---' });
        userStream.write({ '---': `$TARPOINTS_DATA_EXPORT - ${new Date().toISOString()}`, '---': '---', '---': '---' });
        userStream.end();

        const userStream2 = format({ headers: true });
        userStream2.on('data', chunk => csvContent += chunk.toString());
        userData.forEach(row => userStream2.write(row));
        userStream2.end();

        csvContent += "\n\n";
        const historyStream = format({ headers: true });
        historyStream.on('data', chunk => csvContent += chunk.toString());
        historyStream.write({ '---': '---', '---': '---', '---': '---' });
        historyStream.write({ '---': `HISTORY_DATA_EXPORT`, '---': '---', '---': '---' });
        historyStream.end();

        const historyStream2 = format({ headers: true });
        historyStream2.on('data', chunk => csvContent += chunk.toString());
        historyData.forEach(row => historyStream2.write(row));
        historyStream2.end();

        fs.writeFileSync(exportPath, csvContent, 'utf8');

        const attachment = new AttachmentBuilder(exportPath)
            .setName(`AstroNADS_${POINTS_LABEL}_export.csv`)
            .setDescription(`Export of all ${POINTS_LABEL} and transaction history.`);

        await safeFinalReply(interaction, {
            content: `✅ ${POINTS_LABEL} and history data exported successfully!`,
            files: [attachment]
        });

        fs.unlinkSync(exportPath);
        logEvent('starpoints', `Data export requested by ${interaction.user.username}.`, interaction);

    } catch (error) {
        logEvent('deployment', `Error in exportCSV: ${error.message}`, interaction);
        return safeFinalReply(interaction, { content: `❌ An error occurred during CSV export: \`${error.message}\`` });
    } finally {
        clientDb.release();
    }
}

async function handleRemoveAllRegistry(interaction, db, logEvent) {
    const confirmationId = `DELETE_ALL_POINTS_CONFIRM_${interaction.user.id}`;
    const rejectionId = `DELETE_ALL_POINTS_REJECT_${interaction.user.id}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(confirmationId)
            .setLabel('CONFIRM DELETE')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(rejectionId)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    return safeFinalReply(interaction, {
        content: `⚠️ **EXTREME DANGER!** Are you sure you want to **DELETE ALL ${POINTS_LABEL} AND HISTORY DATA?** This action is irreversible.`,
        components: [row]
    });
}

async function handleBulkPointsModal(interaction, db, client, logEvent) {
    const bulkDataInput = interaction.fields.getTextInputValue('bulkDataInput');
    const reason = "Bulk Update";
    const lines = bulkDataInput.split('\n').filter(l => l.trim() !== '');
    const validTransactions = [];
    const initialValidationResults = [];
    const guild = interaction.guild;

    if (!guild) {
         await interaction.deferReply({ ephemeral: true });
         await interaction.editReply({ content: `❌ This command can only be used in a server.`});
         return;
    }

    await interaction.deferReply({ ephemeral: true });

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) {
            initialValidationResults.push(`⚠️ Invalid format: \`${line}\`. Expected: [User/ID] [Points]`);
            continue;
        }

        const usernameOrId = parts[0];
        const amountString = parts[1];
        const amount = parseInt(amountString, 10);

        if (isNaN(amount) || amount === 0) {
            initialValidationResults.push(`❌ Invalid points value: \`${amountString}\` in line: \`${line}\``);
            continue;
        }

        let foundId = null;
        let idCandidate = usernameOrId.replace(/<@!?|>/g, '').replace('<@&', '').trim();

        if (idCandidate.length >= 17 && idCandidate.length <= 20 && /^\d+$/.test(idCandidate)) {
            foundId = idCandidate;
        }

        if (!foundId) {
            const lowerIdentifier = usernameOrId.toLowerCase();
            const member = guild.members.cache.find(m =>
                (m.displayName || '').toLowerCase() === lowerIdentifier ||
                m.user.username.toLowerCase() === lowerIdentifier
            );
            if (member) {
                foundId = member.id;
            } else {
                try {
                    const fetchedUser = await client.users.fetch(idCandidate);
                    foundId = fetchedUser.id;
                } catch (e) {
                    const memberByUsername = guild.members.cache.find(m =>
                        (m.user.username || '').toLowerCase().includes(lowerIdentifier)
                    );
                    if (memberByUsername) {
                        foundId = memberByUsername.id;
                    } else {
                        initialValidationResults.push(`❌ User not found for: \`${usernameOrId}\` in line: \`${line}\``);
                        continue;
                    }
                }
            }
        }

        if (foundId) {
            validTransactions.push({ userId: foundId, amount: amount });
        }
    }

    if (validTransactions.length === 0) {
        const errorContent = `**Bulk Update Failed:**\n\n${initialValidationResults.join('\n')}\n\nNo valid transactions were processed.`;
        return safeFinalReply(interaction, { content: errorContent, ephemeral: true });
    }

    const clientDb = await db.connect();
    let successCount = 0;
    let failureCount = 0;
    const finalResults = [...initialValidationResults];

    try {
        await clientDb.query('BEGIN');
        const giverTag = await fetchUserTag(client, interaction.user.id, guild);

        for (const transaction of validTransactions) {
            const { userId, amount } = transaction;
            const action = amount > 0 ? 'ADD' : 'REMOVE';
            const absAmount = Math.abs(amount);
            const receiverTag = await fetchUserTag(client, userId, guild);

            try {
                await clientDb.query(`
                    INSERT INTO usuarios (user_id, points, username)
                    VALUES ($1, $2, $3)
                    ON CONFLICT(user_id)
                    DO UPDATE
                    SET points = ${action === 'ADD' ? `usuarios.points + ${absAmount}` : `GREATEST(0, usuarios.points - ${absAmount})`},
                    username = $3
                `, [userId, absAmount, receiverTag]);

                await clientDb.query(`
                    INSERT INTO history (giverId, receiverId, amount, reason, timestamp)
                    VALUES ($1, $2, $3, $4, $5)
                `, [interaction.user.id, userId, amount, reason, Date.now()]);

                const newBalance = await getPoints(userId, db);
                await sendDMNotification(client, userId, action, absAmount, newBalance, reason, giverTag);

                finalResults.push(`✅ **${action}** ${absAmount.toLocaleString()} ${POINTS_LABEL} for ${receiverTag}.`);
                successCount++;

            } catch (error) {
                finalResults.push(`❌ Error processing transaction for ${receiverTag} (${userId}): ${error.message}`);
                failureCount++;
            }
        }

        if (failureCount === 0) {
            await clientDb.query('COMMIT');
            logEvent('starpoints', `${successCount} bulk points transactions committed by ${giverTag}.`, interaction);
        } else {
            if (failureCount > 0 && successCount === 0) {
                 await clientDb.query('ROLLBACK');
                 logEvent('starpoints', `Bulk points transaction rolled back due to all failures.`, interaction);
            } else {
                 await clientDb.query('COMMIT');
                 logEvent('starpoints', `${successCount} bulk points transactions committed with ${failureCount} failures by ${giverTag}.`, interaction);
            }
        }

    } catch (error) {
        await clientDb.query('ROLLBACK');
        finalResults.push(`\n\n❌ **CRITICAL ERROR:** An unexpected database error occurred. All transactions were rolled back: \`${error.message}\``);
        logEvent('deployment', `Critical error during bulk points update: ${error.message}`, interaction);
    } finally {
        clientDb.release();
    }

    const finalMessage = `**Bulk Update Results (${successCount} Success / ${failureCount} Failures):**\n\n${finalResults.join('\n')}`;

    return safeFinalReply(interaction, {
        content: finalMessage.length > 2000 ? finalMessage.substring(0, 1900) + '...\n\n(Message too long, see console log for full details)' : finalMessage,
        ephemeral: true
    });
}

async function handleAdminDeleteConfirmation(interaction, db, logEvent) {
    const clientDb = await db.connect();
    try {
        await clientDb.query('BEGIN');
        await clientDb.query('DELETE FROM history');
        await clientDb.query('DELETE FROM usuarios');
        await clientDb.query('COMMIT');

        logEvent('deployment', `**CRITICAL ACTION:** All ${POINTS_LABEL} and history data DELETED by ${interaction.user.username}.`, interaction);
        return safeFinalReply(interaction, { content: `✅ **SUCCESS:** All ${POINTS_LABEL} and history data have been **DELETED** permanently.`, components: [] });

    } catch (error) {
        await clientDb.query('ROLLBACK');
        logEvent('deployment', `Critical error during database wipe: ${error.message}`, interaction);
        return safeFinalReply(interaction, { content: `❌ **ERROR:** An error occurred during the delete process: \`${error.message}\`` });
    } finally {
        clientDb.release();
    }
}


// **SETUP & EXPORT**

async function createPointsTables(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
            user_id VARCHAR(20) PRIMARY KEY,
            username VARCHAR(255),
            points BIGINT DEFAULT 0
        );
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS history (
            id SERIAL PRIMARY KEY,
            giverId VARCHAR(20) NOT NULL,
            receiverId VARCHAR(20) NOT NULL,
            amount BIGINT NOT NULL,
            reason TEXT,
            timestamp BIGINT
        );
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS scheduled_credits (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            recipient_type VARCHAR(10) NOT NULL,
            recipient_id VARCHAR(20) NOT NULL,
            amount INTEGER NOT NULL,
            interval_hours INTEGER NOT NULL,
            created_by VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            last_execution TIMESTAMP,
            execution_count INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT true
        );
    `);
}

export async function initPoints(client, db, logEvent) {
    try {
        await createPointsTables(db);
        console.log("Points tables created/verified successfully.");
        
        // Load active schedules on startup
        await loadActiveSchedules(db, client, logEvent);
    } catch (error) {
        console.error("Error creating Points tables:", error);
    }

    client.pointsCommands = new Map();

    const pointCommand = {
        data: commands.find(c => c.name === 'starpoints'),
        execute: execute,
    };

    const helpCommand = {
        data: commands.find(c => c.name === 'help'),
        execute: async (interaction) => {
             return robustReply(interaction, { content: "Use the **/central help** command to list all available commands.", ephemeral: true });
        }
    };

    const exportCSVCommand = {
        data: commands.find(c => c.name === 'exportcsv'),
        execute: async (interaction) => {
             await handleExportCSV(interaction, db, client);
        }
    };

    client.pointsCommands.set(pointCommand.data.name, pointCommand);
    client.pointsCommands.set(helpCommand.data.name, helpCommand);
    client.pointsCommands.set(exportCSVCommand.data.name, exportCSVCommand);

    // Centralized handlers for index.js
    client.handleBankInteraction = handleBankInteraction;
    client.handleBankUserSelect = handleBankUserSelect;
    client.handleBankModalSubmit = handleBankModalSubmit;
    client.handleAdminDeleteConfirmation = handleAdminDeleteConfirmation;

    console.log(`Loaded ${client.pointsCommands.size} points module commands.`);
}

export const commandList = commands;
export { 
    handleBulkPointsModal, 
    handleBankInteraction, 
    handleBankUserSelect, 
    handleBankModalSubmit, 
    handleAdminDeleteConfirmation,
    handleScheduleModalSubmit,
    handleScheduleRecipientTypeSelect,
    handleScheduleRecipientSelect,
    handleCancelScheduleSelect
};
