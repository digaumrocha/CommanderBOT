import { 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    PermissionFlagsBits,
    AttachmentBuilder 
} from "discord.js";
import path from "path";
import ExcelJS from 'exceljs'; 
import { isContext } from "vm";

const LOG_MODULE_NAME = 'marketplace';
const MARKETPLACE_POINTS_LABEL = "$tarpoints"; 
const PURPLE_COLOR = 0x8a2be2; // Cor Roxa/BlueViolet, consistente com points.js


const safeEditReply = async (interaction, options) => {
    const EPHEMERAL_FLAG = 1 << 6;
    const isPublic = interaction.ephemeral === false;

    try {
        if (interaction.deferred || interaction.replied) {
            // Já foi deferido ou respondido → usa editReply
            return await interaction.editReply(options);
        } else {
            // Primeira resposta → usa reply direto
            return await interaction.reply({ ...options, flags: isPublic ? undefined : EPHEMERAL_FLAG });
        }
    } catch (e) {
        console.error("⚠️ Critical failure in safeEditReply:", e.message);
        try {
            // Última tentativa com followUp (só se possível)
            return await interaction.followUp({ ...options, flags: isPublic ? undefined : EPHEMERAL_FLAG });
        } catch (followUpError) {
            console.error("⚠️ FollowUp also failed:", followUpError.message);
            return;
        }
    }
};

/**
 * @description Tenta dar defer à interação, tratando os erros "InteractionAlreadyReplied" e 10062 de forma segura.
 * @returns {Promise<boolean>} True se o defer foi bem-sucedido ou já estava deferido, False se a interação expirou (10062).
 */
async function safeDefer(interaction, isUpdate = true, isEphemeral = true) {
    // 1. Verificação de estado (Discord.js)
    if (interaction.deferred || interaction.replied) {
        return true; 
    }
    
    try {
        // 2. Tenta o deferral
        if (isUpdate) {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply({ ephemeral: isEphemeral });
        }
        return true;
    } catch (e) {
        // 3. Captura e trata exceções
        
        // Discord API Error 10062: Unknown interaction (interação expirada)
        if (e.code === 10062) {
            console.warn(`[MARKETPLACE] Expired interaction (10062) caught during deferral. Execution stopped cleanly.`);
            return false;
        }
        
        // CORREÇÃO CRÍTICA FINAL: Captura o erro 'InteractionAlreadyReplied' que ocorre no deferral do Slash Command
        if (e.code === 'InteractionAlreadyReplied') {
             console.warn(`[MARKETPLACE] Safe deferral caught InteractionAlreadyReplied crash. Assuming successful prior deferral and continuing execution.`);
             return true; 
        }
        
        // Para quaisquer outros erros, o erro é propagado
        throw e;
    }
}

async function generateXLSXBuffer(datasets) {
    const workbook = new ExcelJS.Workbook();
    
    const headerStyle = {
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } },
        font: { bold: true }
    };

    for (const [sheetName, data] of Object.entries(datasets)) {
        if (!data || data.length === 0) continue;

        const worksheet = workbook.addWorksheet(sheetName);
        const headers = Object.keys(data[0]);

        const excelHeaders = headers.map(h => ({
            header: h.toUpperCase().replace(/_/g, ' ').replace(/ROLE ID/g, 'ROLE ID'),
            key: h,
            width: 15
        }));
        worksheet.columns = excelHeaders;
        worksheet.addRows(data);
        
        worksheet.getRow(1).fill = headerStyle.fill;
        worksheet.getRow(1).font = headerStyle.font;

        worksheet.columns.forEach(column => {
            let maxLength = 0;
            const columnKey = column.key;

            if (columnKey.includes('user id') || columnKey.includes('id') || columnKey.includes('role id')) {
                column.numFmt = '@'; 
                column.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
                    if (rowNumber > 1 && cell.value !== null) {
                        cell.value = String(cell.value);
                    }
                });
            }

            column.width = Math.max(maxLength + 2, 15);
        });

        if (data.length > 0) {
            worksheet.autoFilter = {
                from: 'A1',
                to: `${String.fromCharCode(64 + headers.length)}1`, 
            };
        }
    }

    return workbook.xlsx.writeBuffer();
}

async function sendDMNotification(client, userId, action, amount, newBalance, reason, giverOrReceiverTag) {
    try {
        const user = await client.users.fetch(userId);
        
        let title;
        let description;
        let color = PURPLE_COLOR; 

        const POINTS = MARKETPLACE_POINTS_LABEL; 

        if (action === 'MARKETPLACE_PURCHASE') {
             title = `🛒 Marketplace Purchase!`;
             description = `You spent **${amount.toLocaleString()} ${POINTS}** on item: **${reason}**.\n\nYour new balance is: **${newBalance.toLocaleString()} ${POINTS}**`;
             color = 0x9b59b6; 
        } else {
             return;
        }

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(title)
            .setDescription(description)
            .addFields({ name: 'Details', value: `Purchased Item: ${reason}`, inline: false })
            .setFooter({ text: 'AstroNADS Bank Notification (Marketplace)' })
            .setTimestamp();
            
        await user.send({ embeds: [embed] }).catch(err => {
            console.warn(`[MARKETPLACE] Failed to send DM to user ${userId}: ${err.message}`);
        });
    } catch (error) {
        console.error(`[MARKETPLACE] Error in sendDMNotification for user ${userId}: ${error.message}`);
    }
}


async function notifyPurchase(db, client, item, userId, userName, guildName) {
    const result = await db.query("SELECT value FROM market_state WHERE key = $1", ['purchase_log_channel_id']);
    
    if (!result.rows || result.rows.length === 0 || !result.rows[0].value) return; 

    const channelId = result.rows[0].value;
    
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            console.warn(`[MARKETPLACE] Log channel ID (${channelId}) found but channel could not be fetched.`);
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('🛒 New Marketplace Purchase')
            .setDescription(`Details of the completed transaction on the server **${guildName}**.`)
            .addFields(
                { name: 'Item Purchased', value: `[ID ${item.id}] **${item.name}**`, inline: true },
                { name: 'Price Paid', value: `${item.price.toLocaleString()} ${MARKETPLACE_POINTS_LABEL}`, inline: true }, 
                { name: 'Quantity', value: '1', inline: true },
                { name: 'Buyer', value: `<@${userId}> (ID: ${userId})`, inline: false },
                { name: 'Purchase Time', value: new Date().toLocaleTimeString('en-US'), inline: false }
            )
            .setFooter({ text: `Purchase Record | ${userName}` })
            .setTimestamp();

        await channel.send({ embeds: [embed] });

    } catch (e) {
        console.error(`[MARKETPLACE] Failed to send purchase notification to channel ${channelId}:`, e.message);
    }
}

async function recordPurchase(clientDb, item, userId, userName, interaction) {
    const timestamp = Date.now();
    const date = new Date(timestamp).toISOString().split('T')[0];
    const time = new Date(timestamp).toLocaleTimeString('en-US');
    
    await clientDb.query(`
        INSERT INTO purchase_history (user_id, username, item_id, item_name, quantity, date, time, timestamp) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [userId, userName, item.id, item.name, 1, date, time, timestamp]);
}

const getCurrentPageFromEmbed = (embeds) => {
     if (!embeds || embeds.length === 0 || !embeds[0].description) return 1;
     const description = embeds[0].description || '';
     const match = description.match(/Page (\d+) of \d+/);
     return match ? parseInt(match[1]) : 1;
}

const generateMarketEmbedAndComponents = async (db, client, page = 1) => {
    // 10 itens por página é o padrão atual, e é mantido.
    const itemsPerPage = 10; 
    
    const result = await db.query("SELECT * FROM marketplace");
    const allItems = result.rows;
    const totalItems = allItems.length;
    const BOT_AVATAR = client.user.displayAvatarURL();

    if (!totalItems) {
        // Se a mensagem pública estiver configurada, ela será editada para mostrar que não há itens.
        return { content: "🛒 No items found in the Marketplace." }; 
    }

    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;

    const itemsToShow = allItems.slice(startIndex, endIndex);
    
    // NOVO FORMATO DE COLUNAS (3 por linha)
    const embedFields = [];
    for (const item of itemsToShow) {
        // Conteúdo do campo formatado para ser compacto
        const fieldContent = 
            `💰 **Price:** ${item.price.toLocaleString()} ${MARKETPLACE_POINTS_LABEL}\n` +
            `📦 **Stock:** ${item.quantity === -1 ? 'Infinite' : item.quantity.toLocaleString()}\n` +
            `*Desc: ${item.description.substring(0, 40)}${item.description.length > 40 ? '...' : ''}*`;
            
        embedFields.push({
            name: `[ID ${item.id}] **${item.name}**`,
            value: fieldContent,
            inline: true, // Crucial para o layout em colunas
        });
    }

    // Adiciona campos vazios para alinhar a última linha se não tiver 3 itens
    while (embedFields.length % 3 !== 0 && embedFields.length > 0) {
        embedFields.push({ name: '\u200b', value: '\u200b', inline: true });
    }

    const mainEmbed = new EmbedBuilder()
        .setColor(PURPLE_COLOR) // Cor Roxa
        .setDescription(
            `## 🛒 AstroNADS Marketplace 🛒\n\n` +
            `Welcome! Here you can exchange your **${MARKETPLACE_POINTS_LABEL}** for unique items.\n\n` +
            `Displaying **${itemsToShow.length}** items (Page ${currentPage} of ${totalPages}).\n\n` +
            `*Use the buy buttons below or the \`/buy\` command to purchase.*`
        )
        .setThumbnail(BOT_AVATAR) // Usa o avatar do bot
        .addFields(embedFields)
        .setFooter({ text: `AstroNADS Marketplace | Use the buttons below to interact` })
        .setTimestamp();

    const buyActionRows = [];
    let currentRow = new ActionRowBuilder();
    const maxButtonsPerRow = 5;

    // Apenas os 5 primeiros itens da página atual terão botões de compra rápida
    for (let i = 0; i < itemsToShow.length; i++) {
        if (i < maxButtonsPerRow) {
            const item = itemsToShow[i];
            const buyButton = new ButtonBuilder()
                .setCustomId(`buy_item:${item.id}`)
                .setLabel(`Buy ID ${item.id} (${item.price.toLocaleString()} SP)`)
                .setStyle(item.quantity > 0 || item.quantity === -1 ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(item.quantity === 0); // Desabilita se o estoque for 0

            currentRow.addComponents(buyButton);

            const isRowFull = currentRow.components.length === maxButtonsPerRow;
            const isLastBuyButton = i === Math.min(itemsToShow.length, maxButtonsPerRow) - 1; 

            if (isRowFull || isLastBuyButton) {
                buyActionRows.push(currentRow);
                currentRow = new ActionRowBuilder();
            }
        }
    }
    
    const navigationRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`market_page:1`)
            .setLabel('<< First')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 1),
        new ButtonBuilder()
            .setCustomId(`market_page:${currentPage - 1}`)
            .setLabel('< Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 1),
        new ButtonBuilder()
            .setCustomId(`market_page:${currentPage + 1}`)
            .setLabel('Next >')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === totalPages),
        new ButtonBuilder()
            .setCustomId(`market_page:${totalPages}`)
            .setLabel('Last >>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === totalPages),
    );
    
    const components = [...buyActionRows]; 
    // Mostra os botões de navegação APENAS se houver mais de uma página (mais de 10 itens)
    if (totalPages > 1) { 
        components.push(navigationRow);
    }

    return { embeds: [mainEmbed], components: components, ephemeral: false };
};

async function getItemById(db, itemId) {
    const result = await db.query("SELECT * FROM marketplace WHERE id = $1", [itemId]);
    return result.rows[0]; 
}

async function addToInventory(clientDb, userId, itemId, quantity = 1) {
    await clientDb.query(`
        INSERT INTO inventory (user_id, item_id, quantity, acquisition_date) 
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, item_id) 
        DO UPDATE SET quantity = inventory.quantity + $3
    `, [userId, itemId, quantity]);
    
    // Diminui o estoque apenas se não for -1 (infinito)
    await clientDb.query(`
        UPDATE marketplace 
        SET quantity = GREATEST(-1, quantity - $1)
        WHERE id = $2 AND quantity <> -1
    `, [quantity, itemId]);
}

async function getMarketStateValue(db, key) {
    const result = await db.query("SELECT value FROM market_state WHERE key = $1", [key]);
    return result.rows[0]?.value; 
}

async function setMarketStateValue(db, key, value) {
    await db.query(`
        INSERT INTO market_state (key, value) 
        VALUES ($1, $2)
        ON CONFLICT (key) 
        DO UPDATE SET value = $2
    `, [key, value]);
}

async function getAllMarketplaceData(db) {
    const data = {};
    data.MarketplaceItems = (await db.query("SELECT * FROM marketplace ORDER BY id ASC")).rows;
    data.UserInventory = (await db.query("SELECT * FROM inventory WHERE quantity > 0 ORDER BY user_id ASC")).rows;
    data.PurchaseHistory = (await db.query("SELECT * FROM purchase_history ORDER BY id DESC")).rows;
    data.MarketState = (await db.query("SELECT * FROM market_state")).rows;
    return data;
}

// ----------------------------------------------------
// FUNÇÃO PARA ATUALIZAR O EMBED PÚBLICO
// ----------------------------------------------------
async function updateMarketplaceDisplay(db, client, logEvent) {
    const channelId = await getMarketStateValue(db, 'marketplace_channel_id');
    const messageId = await getMarketStateValue(db, 'marketplace_message_id');

    if (!channelId || !messageId) {
        return { success: false, reason: "Display not configured (channel or message ID missing)." };
    }
    
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            await setMarketStateValue(db, 'marketplace_channel_id', '');
            await setMarketStateValue(db, 'marketplace_message_id', '');
            return { success: false, reason: "Channel not found or invalid. Configuration cleared." };
        }

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) {
            await setMarketStateValue(db, 'marketplace_message_id', '');
            return { success: false, reason: "Message not found. Configuration cleared." };
        }

        const oldComponents = message.components;
        // Tenta obter a página atual para não resetar a visualização
        const currentPage = getCurrentPageFromEmbed(message.embeds); 

        // Gera o novo embed com os dados atualizados
        const { embeds, components: newComponents, content } = await generateMarketEmbedAndComponents(db, client, currentPage);
        
        // Preserva o botão 'Back to ATM' se ele existir
        const atmButtonRow = oldComponents.find(row => 
            row.components.some(c => c.customId && c.customId.startsWith('ATM_BACK'))
        );
        if (atmButtonRow) {
             newComponents.push(atmButtonRow);
        }
        
        // Se não houver mais itens, use o conteúdo simples. Caso contrário, use embeds e componentes.
        if (content) {
             await message.edit({ content: content, embeds: [], components: [] }).catch(e => {
                logEvent(LOG_MODULE_NAME, `Error editing persistent marketplace message (content update): ${e.message}`);
                throw e;
            });
        } else {
             await message.edit({ embeds, components: newComponents }).catch(e => {
                logEvent(LOG_MODULE_NAME, `Error editing persistent marketplace message (embed update): ${e.message}`);
                throw e;
            });
        }

        return { success: true };
    } catch (e) {
        console.error("[MARKETPLACE] Critical error in updateMarketplaceDisplay:", e);
        return { success: false, reason: `Internal error: ${e.message}` };
    }
}


async function createMarketplaceTables(db) {
    try {
        // 1. Cria a tabela (ou garante que a estrutura base exista)
        await db.query(`
            CREATE TABLE IF NOT EXISTS marketplace (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                price INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                role_id TEXT,
                added_by TEXT,
                added_at TIMESTAMP DEFAULT NOW()
            );
        `);
        
        // 2. CORREÇÃO CRÍTICA (MIGRAÇÃO): Adiciona colunas se a tabela já existia sem elas.
        await db.query(`
            DO $$
            BEGIN
                -- Verifica e adiciona a coluna 'added_by' se ela não existir
                IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'marketplace'::regclass AND attname = 'added_by') THEN
                    ALTER TABLE marketplace ADD COLUMN added_by TEXT;
                END IF;
                -- Verifica e adiciona a coluna 'added_at' se ela não existir
                IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'marketplace'::regclass AND attname = 'added_at') THEN
                    ALTER TABLE marketplace ADD COLUMN added_at TIMESTAMP DEFAULT NOW();
                END IF;
            END
            $$;
        `).catch(err => {
             // Ignora o erro se a tabela 'marketplace' nem sequer existir (improvável)
            if (!err.message.includes('relation "marketplace" does not exist')) {
                 throw err;
            }
        });
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS inventory (
                user_id TEXT NOT NULL,
                item_id INTEGER REFERENCES marketplace(id) ON DELETE CASCADE,
                quantity INTEGER NOT NULL DEFAULT 0,
                acquisition_date TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (user_id, item_id)
            );
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS purchase_history (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                username TEXT,
                item_id INTEGER REFERENCES marketplace(id) ON DELETE SET NULL,
                item_name TEXT,
                quantity INTEGER NOT NULL,
                date TEXT,
                time TEXT,
                timestamp BIGINT
            );
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS market_state (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        
        // Garante que as chaves de estado existam e tenham valores padrão
        await setMarketStateValue(db, 'purchase_log_channel_id', await getMarketStateValue(db, 'purchase_log_channel_id') || '');
        await setMarketStateValue(db, 'marketplace_channel_id', await getMarketStateValue(db, 'marketplace_channel_id') || '');
        await setMarketStateValue(db, 'marketplace_message_id', await getMarketStateValue(db, 'marketplace_message_id') || '');

        console.log("Marketplace tables verified/created successfully.");
    } catch (error) {
        console.error("Error creating Marketplace tables:", error);
        throw error;
    }
}

async function getPointsBalance(db, userId) {
    const result = await db.query("SELECT points FROM usuarios WHERE user_id = $1", [userId]);
    return result.rows[0]?.points || 0;
}

async function updatePointsBalance(clientDb, userId, amount) {
    if (amount < 0) {
        await clientDb.query(`
            UPDATE usuarios
            SET points = GREATEST(0, points + $2)
            WHERE user_id = $1
        `, [userId, amount]); 
    } else {
        await clientDb.query(`
            INSERT INTO usuarios (user_id, points)
            VALUES ($1, $2)
            ON CONFLICT(user_id)
            DO UPDATE
            SET points = usuarios.points + $2
        `, [userId, amount]);
    }
}


async function buyitemLogic(interaction, db, client, logEvent) {
    const itemId = parseInt(interaction.options.getString('item_id') || interaction.options.getInteger('item_id') || (interaction.customId ? interaction.customId.split(':')[1] : null));
    const quantity = interaction.options.getInteger('quantity') || 1;
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const guildName = interaction.guild?.name || 'DM/Unknown Guild';
    const isButtonInteraction = interaction.isButton(); 

    if (!itemId) {
        return safeEditReply(interaction, { content: "❌ ID de item inválido ou ausente.", ephemeral: true });
    }

    if (quantity <= 0) {
         return safeEditReply(interaction, { content: "❌ A quantidade deve ser um número positivo.", ephemeral: true });
    }

    let item;
    try {
        item = await getItemById(db, itemId);
    } catch (error) {
        logEvent(LOG_MODULE_NAME, `Error fetching item ID ${itemId}: ${error.message}`, interaction);
        return safeEditReply(interaction, { content: `❌ Ocorreu um erro interno ao buscar o item ID ${itemId}.`, ephemeral: true });
    }

    if (!item) {
        return safeEditReply(interaction, { content: `❌ Item com ID **${itemId}** não encontrado no Marketplace.`, ephemeral: true });
    }

    const totalPrice = item.price * quantity;

    if (item.quantity !== -1 && item.quantity < quantity) {
        return safeEditReply(interaction, { content: `❌ O Item **${item.name}** possui apenas **${item.quantity.toLocaleString()}** unidades em estoque. Não é possível comprar **${quantity}** unidades.`, ephemeral: true });
    }

    let userBalance;
    try {
        userBalance = await getPointsBalance(db, userId); 
    } catch (error) {
        logEvent(LOG_MODULE_NAME, `Error fetching balance for user ${userId}: ${error.message}`, interaction);
        return safeEditReply(interaction, { content: "❌ Ocorreu um erro interno ao buscar seu saldo.", ephemeral: true });
    }

    if (userBalance < totalPrice) {
        return safeEditReply(interaction, { content: `❌ Saldo insuficiente! Você precisa de **${totalPrice.toLocaleString()} ${MARKETPLACE_POINTS_LABEL}** mas só tem **${userBalance.toLocaleString()} ${MARKETPLACE_POINTS_LABEL}**.`, ephemeral: true });
    }

    // --- LÓGICA DE TRANSAÇÃO (COMMIT/ROLLBACK) ---

    const clientDb = await db.connect();
    let success = true;
    try {
        await clientDb.query('BEGIN'); 

        // 1. Deducao do saldo
        await updatePointsBalance(clientDb, userId, -totalPrice); 

        // 2. Adicionar ao inventario e remover do estoque
        await addToInventory(clientDb, userId, itemId, quantity);

        // 3. Atribuir Role
        if (item.role_id && interaction.guild) {
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            if (member) {
                await member.roles.add(item.role_id, `Marketplace purchase of item ID ${itemId}`).catch(e => {
                    logEvent(LOG_MODULE_NAME, `Failed to assign role ${item.role_id} to user ${userId}: ${e.message}`, interaction);
                });
            }
        }
        
        // 4. Registrar historico
        await recordPurchase(clientDb, item, userId, userName, interaction);

        await clientDb.query('COMMIT'); 

    } catch (error) {
        success = false;
        logEvent(LOG_MODULE_NAME, `Critical transaction error for user ${userId} and item ${itemId}: ${error.message}`, interaction);

        try {
            await clientDb.query('ROLLBACK'); 
            logEvent(LOG_MODULE_NAME, `Transaction successfully rolled back for user ${userId}.`, interaction);
        } catch (rollbackError) {
             logEvent(LOG_MODULE_NAME, `Failed to roll back transaction for user ${userId}: ${rollbackError.message}. CRITICAL DATA INCONSISTENCY!`, interaction);
        }

        // Usa safeEditReply
        return safeEditReply(interaction, { 
            content: `❌ Ocorreu um erro crítico durante a transação. Seu saldo foi totalmente reembolsado. Entre em contato com um administrador. Erro: \`${error.message}\``, 
            ephemeral: true 
        });
    } finally {
        clientDb.release(); 
    }

    if (success) {
        const newBalance = await getPointsBalance(db, userId); 
        
        // 5. Notificacoes
        await notifyPurchase(db, client, item, userId, userName, guildName);
        await sendDMNotification(client, userId, 'MARKETPLACE_PURCHASE', totalPrice, newBalance, item.name, null);

        // 6. Atualiza o display público (se configurado)
        await updateMarketplaceDisplay(db, client, logEvent); 

        // Resposta de confirmação
        const purchaseReply = `✅ Compra realizada com sucesso! Você comprou **${quantity}x ${item.name}** por **${totalPrice.toLocaleString()} ${MARKETPLACE_POINTS_LABEL}**. Seu novo saldo é **${newBalance.toLocaleString()} ${MARKETPLACE_POINTS_LABEL}**.`;
        
        if (isButtonInteraction && interaction.message) {
            // Se foi uma compra via botão, atualiza a mensagem original do Marketplace
            const currentPage = getCurrentPageFromEmbed(interaction.message.embeds);
            const { embeds: updatedEmbeds, components: updatedComponents } = await generateMarketEmbedAndComponents(db, client, currentPage);

            // Re-adiciona o botão 'Back to ATM' se ele estava presente (para ATM)
            const atmButton = interaction.message.components.find(row => 
                 row.components.some(c => c.customId && c.customId.startsWith('ATM_BACK'))
            );
            if (atmButton) {
                 updatedComponents.push(atmButton);
            }
            
            // Edita a mensagem original com o estoque atualizado (funciona tanto para ephemeral quanto público)
            await interaction.message.edit({ embeds: updatedEmbeds, components: updatedComponents }).catch(e => {
                console.warn(`[MARKETPLACE] Failed to edit original market message after purchase: ${e.message}`);
            });
            
            // Resposta de confirmação ephemeral (separada da mensagem do marketplace)
            return safeEditReply(interaction, { 
                content: purchaseReply, 
                ephemeral: true 
            });
        }
        
        // Resposta ephemeral original (para slash command buy)
        return safeEditReply(interaction, { 
            content: purchaseReply, 
            ephemeral: true 
        });
    }
}


// Comando /marketadmin
const marketplaceCommand = {
    data: new SlashCommandBuilder()
        .setName('marketadmin')
        .setDescription('Comandos administrativos para o Marketplace.')
        // Subcomando ADD
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Adiciona um novo item ao marketplace.')
                .addStringOption(option => 
                    option.setName('name')
                        .setDescription('Nome do item.')
                        .setRequired(true))
                .addStringOption(option => 
                    option.setName('description')
                        .setDescription('Descrição do item.')
                        .setRequired(true))
                .addIntegerOption(option => 
                    option.setName('price')
                        .setDescription('Preço do item em StarPoints.')
                        .setRequired(true)
                        .setMinValue(0))
                .addIntegerOption(option => 
                    option.setName('quantity')
                        .setDescription('Quantidade inicial (-1 para estoque infinito).')
                        .setRequired(true))
                .addRoleOption(option => 
                    option.setName('role_reward')
                        .setDescription('Cargo a ser concedido na compra (opcional).')
                        .setRequired(false)))
        // Subcomando EDIT
        .addSubcommand(subcommand =>
            subcommand
                .setName('edit')
                .setDescription('Edita um item existente no marketplace.')
                .addIntegerOption(option => 
                    option.setName('item_id')
                        .setDescription('ID do item a ser editado.')
                        .setRequired(true))
                .addStringOption(option => 
                    option.setName('name')
                        .setDescription('Novo nome (opcional).')
                        .setRequired(false))
                .addStringOption(option => 
                    option.setName('description')
                        .setDescription('Nova descrição (opcional).')
                        .setRequired(false))
                .addIntegerOption(option => 
                    option.setName('price')
                        .setDescription('Novo preço (opcional).')
                        .setRequired(false)
                        .setMinValue(0))
                .addIntegerOption(option => 
                    option.setName('quantity')
                        .setDescription('Nova quantidade (defina -1 para infinito).')
                        .setRequired(false))
                .addRoleOption(option => 
                    option.setName('role_reward')
                        .setDescription('Novo cargo a ser concedido na compra (defina 0 para remover).')
                        .setRequired(false)))
        // Subcomando REMOVE
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove um item do marketplace.')
                .addIntegerOption(option => 
                    option.setName('item_id')
                        .setDescription('ID do item a ser removido.')
                        .setRequired(true)))
        // Subcomando LIST
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('Lista todos os itens no marketplace.'))
        // Subcomando ADDSTOCK
        .addSubcommand(subcommand =>
            subcommand
                .setName('addstock')
                .setDescription('Aumenta o estoque de um item existente.')
                .addIntegerOption(option => 
                    option.setName('item_id')
                        .setDescription('ID do item a ser atualizado.')
                        .setRequired(true))
                .addIntegerOption(option => 
                    option.setName('amount')
                        .setDescription('Quantidade a ser adicionada ao estoque.')
                        .setRequired(true)))
        // Subcomando HISTORY
        .addSubcommand(subcommand =>
            subcommand
                .setName('history')
                .setDescription('Visualiza/exporta o histórico de compras.'))
        // Subcomando SETLOGCHANNEL
        .addSubcommand(subcommand =>
            subcommand
                .setName('setlogchannel')
                .setDescription('Define o canal para logs de compra do marketplace.')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('O canal para receber logs de compra.')
                        .setRequired(true)))
        // Subcomando SETDISPLAY
        .addSubcommand(subcommand =>
            subcommand
                .setName('setdisplay')
                .setDescription('Define a mensagem a ser atualizada automaticamente (ID do Canal + ID da Mensagem).')
                .addStringOption(option => 
                    option.setName('channel_id')
                        .setDescription('ID do canal onde o embed do marketplace está exibido.')
                        .setRequired(true))
                .addStringOption(option => 
                    option.setName('message_id')
                        .setDescription('ID da mensagem do embed do marketplace.')
                        .setRequired(true)))
        // Subcomando REMOVEALLITEMS
        .addSubcommand(subcommand =>
            subcommand
                .setName('removeallitems')
                .setDescription('ATENÇÃO: Deleta todos os itens e reinicia o contador de ID.'))
        // NOVO SUBCOMANDO: DISPLAY (Gera mensagem pública do Marketplace)
        .addSubcommand(subcommand =>
            subcommand
                .setName('display')
                .setDescription('Gera uma mensagem pública do Marketplace no canal atual.'))
        // Subcomando EXPORT
        .addSubcommand(subcommand =>
            subcommand
                .setName('export')
                .setDescription('Exporta todos os dados do marketplace (itens, inventário, histórico) para XLSX.')),

    async execute(interaction, db, client, logEvent) {
        const subcommand = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        const userName = interaction.user.username;

        try {
            switch (subcommand) {
                case 'display': {
                    // Gera o marketplace público no canal atual
                    const { embeds, components, content } = await generateMarketEmbedAndComponents(db, client, 1);
                    
                    if (content) {
                        return safeEditReply(interaction, { content: content, ephemeral: true });
                    }
                    
                    // Envia a mensagem pública
                    const publicMessage = await interaction.channel.send({ embeds, components });
                    
                    logEvent(LOG_MODULE_NAME, `Public marketplace display generated in channel ${interaction.channel.id} by ${userName}.`, interaction);
                    
                    return safeEditReply(interaction, { 
                        content: `✅ Marketplace público gerado com sucesso! [Ir para mensagem](${publicMessage.url})\n\n💡 **Dica:** Use \`/marketadmin setdisplay\` com o Channel ID e Message ID para vincular esta mensagem ao sistema de atualização automática.`,
                        ephemeral: true 
                    });
                }
                case 'removeallitems': {
                    // 1. DELETE para respeitar as regras ON DELETE CASCADE/SET NULL das tabelas inventory/purchase_history
                    await db.query('DELETE FROM marketplace');
                    
                    // 2. Reinicia o contador de IDs da tabela 'marketplace' para 1
                    await db.query('ALTER SEQUENCE marketplace_id_seq RESTART WITH 1');
                    
                    logEvent(LOG_MODULE_NAME, `Todos os itens do marketplace foram deletados e o contador de ID reiniciado por ${userName}.`, interaction);
                    
                    // 3. Atualiza o display público
                    await updateMarketplaceDisplay(db, client, logEvent);
                    
                    return safeEditReply(interaction, { 
                        content: `🗑️ **TODOS** os itens do Marketplace foram removidos, e o contador de IDs foi reiniciado para **1**. As entradas de inventário e histórico relacionadas foram atualizadas.`,
                    });
                }
                case 'setdisplay': {
                    const channelId = interaction.options.getString('channel_id');
                    const messageId = interaction.options.getString('message_id');
                    
                    if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
                        return safeEditReply(interaction, { content: "❌ Ambos o ID do Canal e o ID da Mensagem devem ser strings de números válidos.", ephemeral: true });
                    }
                    
                    // Verifica se a mensagem existe antes de configurar
                    try {
                        const channel = await client.channels.fetch(channelId);
                        await channel.messages.fetch(messageId);
                    } catch (e) {
                        return safeEditReply(interaction, { content: "❌ Não foi possível encontrar a mensagem ou o canal com os IDs fornecidos. Verifique se o bot tem permissão para ver e ler o histórico do canal.", ephemeral: true });
                    }

                    await setMarketStateValue(db, 'marketplace_channel_id', channelId);
                    await setMarketStateValue(db, 'marketplace_message_id', messageId);
                    
                    logEvent(LOG_MODULE_NAME, `Marketplace display set to Message ID ${messageId} in Channel ID ${channelId} by ${userName}.`, interaction);
                    
                    // Tenta uma atualização inicial para confirmar se funciona
                    const updateResult = await updateMarketplaceDisplay(db, client, logEvent);
                    
                    if (updateResult.success) {
                         return safeEditReply(interaction, { content: `✅ Exibição do Marketplace vinculada e sincronizada com sucesso com a Mensagem ID **${messageId}** no canal <#${channelId}>.` });
                    } else {
                         return safeEditReply(interaction, { content: `⚠️ O link da exibição do Marketplace foi configurado, mas **falhou ao realizar a atualização inicial**. Motivo: ${updateResult.reason}. Verifique a configuração.` });
                    }
                }
                case 'add': {
                    const name = interaction.options.getString('name');
                    const description = interaction.options.getString('description');
                    const price = interaction.options.getInteger('price');
                    const quantity = interaction.options.getInteger('quantity');
                    const role = interaction.options.getRole('role_reward');
                    const roleId = role ? role.id : null;

                    const result = await db.query(`
                        INSERT INTO marketplace (name, description, price, quantity, role_id, added_by) 
                        VALUES ($1, $2, $3, $4, $5, $6) 
                        RETURNING id
                    `, [name, description, price, quantity, roleId, userId]);

                    const newId = result.rows[0].id;
                    logEvent(LOG_MODULE_NAME, `Item ID ${newId} ('${name}') added by ${userName}.`, interaction);
                    
                    // Atualiza a exibição pública
                    await updateMarketplaceDisplay(db, client, logEvent); 
                    
                    return safeEditReply(interaction, { content: `✅ Item **${name}** adicionado ao Marketplace com ID **${newId}**. Preço: ${price.toLocaleString()} ${MARKETPLACE_POINTS_LABEL}. Estoque: ${quantity === -1 ? 'Infinite' : quantity.toLocaleString()}.` });
                }
                case 'edit': {
                    const itemId = interaction.options.getInteger('item_id');
                    const newName = interaction.options.getString('name');
                    const newDescription = interaction.options.getString('description');
                    const newPrice = interaction.options.getInteger('price');
                    const newQuantity = interaction.options.getInteger('quantity');
                    const newRole = interaction.options.getRole('role_reward');
                    
                    let roleUpdate = '';
                    let roleValue = null;
                    if (newRole !== null) {
                        roleValue = newRole.id;
                        roleUpdate = ', role_id = $7';
                    } else if (interaction.options.getString('role_reward') === '0') {
                        roleUpdate = ', role_id = NULL';
                    }

                    const updates = [];
                    const values = [];
                    let paramIndex = 1;

                    if (newName) {
                        updates.push(`name = $${paramIndex++}`);
                        values.push(newName);
                    }
                    if (newDescription) {
                        updates.push(`description = $${paramIndex++}`);
                        values.push(newDescription);
                    }
                    if (newPrice !== null) {
                        updates.push(`price = $${paramIndex++}`);
                        values.push(newPrice);
                    }
                    if (newQuantity !== null) {
                        updates.push(`quantity = $${paramIndex++}`);
                        values.push(newQuantity);
                    }
                    if (newRole !== null) {
                        updates.push(`role_id = $${paramIndex++}`);
                        values.push(newRole.id);
                    } else if (interaction.options.getString('role_reward') === '0') {
                         updates.push(`role_id = NULL`);
                    }

                    if (updates.length === 0) {
                        return safeEditReply(interaction, { content: "⚠️ Nenhum campo fornecido para atualização. Nada foi alterado.", ephemeral: true });
                    }
                    
                    values.push(itemId); 
                    
                    const query = `
                        UPDATE marketplace 
                        SET ${updates.join(', ')}
                        WHERE id = $${paramIndex}
                        RETURNING name
                    `;
                    
                    const result = await db.query(query, values);

                    if (result.rowCount === 0) {
                         return safeEditReply(interaction, { content: `❌ Item com ID **${itemId}** não encontrado.`, ephemeral: true });
                    }

                    logEvent(LOG_MODULE_NAME, `Item ID ${itemId} ('${result.rows[0].name}') editado por ${userName}.`, interaction);
                    
                    // Atualiza a exibição pública
                    await updateMarketplaceDisplay(db, client, logEvent); 
                    
                    return safeEditReply(interaction, { content: `✅ Item **${result.rows[0].name}** (ID **${itemId}**) atualizado com sucesso!` });
                }
                case 'remove': {
                    const itemId = interaction.options.getInteger('item_id');
                    
                    const result = await db.query(`
                        DELETE FROM marketplace 
                        WHERE id = $1
                        RETURNING name
                    `, [itemId]);
                    
                    if (result.rowCount === 0) {
                         return safeEditReply(interaction, { content: `❌ Item com ID **${itemId}** não encontrado.`, ephemeral: true });
                    }

                    logEvent(LOG_MODULE_NAME, `Item ID ${itemId} ('${result.rows[0].name}') removido por ${userName}.`, interaction);
                    
                    // Atualiza a exibição pública
                    await updateMarketplaceDisplay(db, client, logEvent); 
                    
                    return safeEditReply(interaction, { content: `✅ Item **${result.rows[0].name}** (ID **${itemId}**) removido do Marketplace.` });
                }
                case 'list': {
                    // Pass client to generateMarketEmbedAndComponents
                    const { embeds, components, content } = await generateMarketEmbedAndComponents(db, client);
                    if (content) {
                         return safeEditReply(interaction, { content: content, ephemeral: true });
                    }
                    return safeEditReply(interaction, { embeds, components, ephemeral: true });
                }
                case 'addstock': {
                    const itemId = interaction.options.getInteger('item_id');
                    const amount = interaction.options.getInteger('amount');
                    
                    const result = await db.query(`
                        UPDATE marketplace 
                        SET quantity = quantity + $1
                        WHERE id = $2 AND quantity <> -1
                        RETURNING name, quantity
                    `, [amount, itemId]);

                    if (result.rowCount === 0) {
                         return safeEditReply(interaction, { content: `❌ Item com ID **${itemId}** não encontrado ou já possui estoque infinito (-1).`, ephemeral: true });
                    }
                    
                    logEvent(LOG_MODULE_NAME, `${amount.toLocaleString()} unidades adicionadas ao estoque do item ID ${itemId} ('${result.rows[0].name}') por ${userName}.`, interaction);
                    
                    // Atualiza a exibição pública
                    await updateMarketplaceDisplay(db, client, logEvent); 
                    
                    return safeEditReply(interaction, { content: `✅ **${amount.toLocaleString()}** unidades adicionadas ao estoque de **${result.rows[0].name}** (ID **${itemId}**). Novo estoque: **${result.rows[0].quantity.toLocaleString()}**.` });
                }
                case 'history': {
                    const history = await db.query("SELECT * FROM purchase_history ORDER BY timestamp DESC");
                    
                    if (history.rows.length === 0) {
                        return safeEditReply(interaction, { content: "📜 O histórico de compras está vazio.", ephemeral: true });
                    }

                    const historyData = history.rows.map(row => ({
                        id: row.id,
                        item_id: row.item_id,
                        item_name: row.item_name,
                        user_id: row.user_id,
                        username: row.username,
                        quantity: row.quantity,
                        date: row.date,
                        time: row.time,
                        timestamp: row.timestamp
                    }));

                    const xlsxBuffer = await generateXLSXBuffer({ 'Purchase History': historyData });
                    const attachment = new AttachmentBuilder(xlsxBuffer, { name: 'purchase_history.xlsx' });

                    return safeEditReply(interaction, { 
                        content: `📜 **Total de ${history.rows.length} compras registradas.** Veja o arquivo abaixo para o histórico completo.`, 
                        files: [attachment] 
                    });
                }
                case 'setlogchannel': {
                    const channel = interaction.options.getChannel('channel');
                    await setMarketStateValue(db, 'purchase_log_channel_id', channel.id);
                    logEvent(LOG_MODULE_NAME, `Purchase log channel set to ${channel.id} by ${userName}.`, interaction);
                    return safeEditReply(interaction, { content: `✅ Os logs de compra agora serão enviados para ${channel}.` });
                }
                case 'export': {
                    const data = await getAllMarketplaceData(db); 
                    
                    const xlsxBuffer = await generateXLSXBuffer(data);
                    const attachment = new AttachmentBuilder(xlsxBuffer, { name: 'marketplace_full_export.xlsx' });
                    
                    return safeEditReply(interaction, { 
                        content: `📦 **Exportação completa do Marketplace concluída.** O arquivo contém lista de itens, inventário e histórico de compras.`, 
                        files: [attachment] 
                    });
                }
                default:
                    return safeEditReply(interaction, { content: "⚠️ Subcomando desconhecido.", ephemeral: true });
            }
        } catch (error) {
            logEvent(LOG_MODULE_NAME, `Error executing /marketadmin ${subcommand}: ${error.message}`, interaction);
            console.error(error);
            // Verifica se o erro é de coluna faltando e sugere a migração
            if (error.message.includes('column "added_by" of relation "marketplace" does not exist')) {
                 return safeEditReply(interaction, { content: `❌ **Erro de Migração Detectado:** A tabela de banco de dados 'marketplace' está faltando a coluna 'added_by'. Por favor, **reinicie o seu bot** para executar a migração automática do esquema. Se o erro persistir após a reinicialização, contate o administrador do banco de dados.`, ephemeral: true });
            }
            
            return safeEditReply(interaction, { content: `❌ Ocorreu um erro interno durante a execução do comando: \`${error.message}\``, ephemeral: true });
        }
    }
};

// Comando /marketplace (público)
const marketplacePublicCommand = {
    data: new SlashCommandBuilder()
        .setName('marketplace')
        .setDescription('Visualiza a lista de itens à venda no Marketplace.')
        .setDMPermission(false), 

    async execute(interaction, db, client, logEvent) {
        try {
            // Pass client to generateMarketEmbedAndComponents
            const { embeds, components, content } = await generateMarketEmbedAndComponents(db, client);
            if (content) {
                 return safeEditReply(interaction, { content: content, ephemeral: false }); 
            }
            // Se chamado pelo ATM, o botão 'Back to ATM' precisa ser adicionado
            if (interaction.backToATMButton) {
                components.push(interaction.backToATMButton);
            }
            return safeEditReply(interaction, { embeds, components, ephemeral: false }); 
        } catch (error) {
            logEvent(LOG_MODULE_NAME, `Error executing /marketplace: ${error.message}`, interaction);
            return safeEditReply(interaction, { content: `❌ Ocorreu um erro interno ao buscar itens do Marketplace: \`${error.message}\``, ephemeral: true });
        }
    }
};


async function handleButtonInteraction(interaction, db, client, logEvent) {
    if (interaction.isAnySelectMenu()) return; 

    const customId = interaction.customId;
    
    // Lógica para navegação de página
    if (customId.startsWith('market_page:')) {
        const page = parseInt(customId.split(':')[1]);
        if (isNaN(page)) return; 
        
        // Mantemos safeDefer para botões, pois o index.js geralmente não defer updates/botões.
        const deferred = await safeDefer(interaction, true); // isUpdate = true
        if (!deferred) return; // Interação expirou. Parar execução.
        
        try {
            const { embeds, components, content } = await generateMarketEmbedAndComponents(db, client, page);
             if (content) return safeEditReply(interaction, { content: content, ephemeral: false });
             
            // A verificação c.custom_id && c.custom_id.startsWith('ATM_BACK') já trata o TypeError
            const atmButton = interaction.message.components.find(row => 
                 row.components.some(c => c.customId && c.customId.startsWith('ATM_BACK'))
            );
            if (atmButton) {
                 components.push(atmButton);
            }
            
             return safeEditReply(interaction, { embeds, components, ephemeral: false }); 
        } catch (error) {
             logEvent(LOG_MODULE_NAME, `Error navigating market page ${page}: ${error.message}`, interaction);
             // Já foi deferido, então usamos editReply
             return interaction.editReply({ content: `❌ Ocorreu um erro interno durante a navegação: \`${error.message}\``, ephemeral: true });
        }
    }

    // Lógica para botão de compra rápida
    if (customId.startsWith('buy_item:')) {
        const itemId = parseInt(customId.split(':')[1]);
        if (isNaN(itemId)) return;
        
        // Mantemos safeDefer para botões, pois o index.js geralmente não defer updates/botões.
        const deferred = await safeDefer(interaction, false, true); // isUpdate = false, isEphemeral = true
        if (!deferred) return; // Interação expirou. Parar execução.
        
        // VITAL: Criar um objeto de interação que simula o slash command
        const wrappedInteraction = {
            // Mock de opções para a lógica de compra (que espera um slash command options object)
            options: {
                getString: () => null, 
                getInteger: (name) => name === 'item_id' ? itemId : (name === 'quantity' ? 1 : null),
                getRole: () => null,
            },
            
            // PROPRIEDADES DE ESTADO MANUAIS APÓS DEFERRAL BEM-SUCEDIDO
            deferred: true, // EXPLICITAMENTE TRUE, pois safeDefer retornou sucesso
            replied: false, 
            
            isButton: () => true,
            isAnySelectMenu: () => false,
            // Métodos de resposta do interaction real
            editReply: (opts) => interaction.editReply(opts),
            followUp: (opts) => interaction.followUp(opts),
            
            // Outras propriedades necessárias
            user: interaction.user,
            guild: interaction.guild,
            message: interaction.message, 
            customId: interaction.customId,
        };
        
        // CHAMA A LÓGICA CENTRALIZADA DE COMPRA
        return buyitemLogic(wrappedInteraction, db, client, logEvent);
    }
}

export async function initMarketplace(client, db) {
    try {
        await createMarketplaceTables(db);
        
        client.marketplaceCommands = new Map();
        
        if (marketplaceCommand?.data?.name) client.marketplaceCommands.set(marketplaceCommand.data.name, marketplaceCommand); 
        if (marketplacePublicCommand?.data?.name) client.marketplaceCommands.set(marketplacePublicCommand.data.name, marketplacePublicCommand); 
        
        client.handleMarketplaceButtonInteraction = handleButtonInteraction;
        client.generateMarketEmbedAndComponents = generateMarketEmbedAndComponents;
        
        console.log(`Loaded ${client.marketplaceCommands.size} marketplace commands.`);
    } catch (error) {
        console.error("Error initializing marketplace commands:", error);
    }
    console.log("Marketplace initialized successfully!");
}

export const commandList = [marketplaceCommand, marketplacePublicCommand];
export { handleButtonInteraction, generateMarketEmbedAndComponents, safeEditReply, updateMarketplaceDisplay };
