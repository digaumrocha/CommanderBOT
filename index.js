import 'dotenv/config';
import { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder, 
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags,
    Collection,
    StringSelectMenuBuilder,
    RoleSelectMenuBuilder
} from "discord.js";
import { Pool } from 'pg';
import fs from "fs";
import path from "path";

import * as marketplaceModule from "./marketplace/marketplace.js";
import * as pointsModule from "./points/points.js";

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.TOKEN;
const EPHEMERAL_FLAG = MessageFlags.Ephemeral;

const PUBLIC_REPLY_COMMANDS = ['listitems', 'listpoints'];

let db;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.marketplaceCommands = new Map();
client.pointsCommands = new Map();
client.centralCommands = new Map();
client.logChannelIds = {}; 

function logEvent(logType, message, interaction = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}][${logType.toUpperCase()}] ${message}`;
    console.log(logMessage);

    const logFilePath = path.join(process.cwd(), 'logs', 'bot_activity.log');
    if (!fs.existsSync(path.join(process.cwd(), 'logs'))) {
        fs.mkdirSync(path.join(process.cwd(), 'logs'));
    }
    fs.appendFileSync(logFilePath, logMessage + '\n');

    if (client.logChannelIds && client.logChannelIds[logType]) {
        try {
            const channel = client.channels.cache.get(client.logChannelIds[logType]);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor(logType === 'deployment' ? 0x00ff00 : (logType === 'system' ? 0xffff00 : 0x3498db))
                    .setTitle(`[${logType.toUpperCase()} Log]`)
                    .setDescription(message.substring(0, 4096))
                    .setFooter({ text: `Logged by: ${interaction ? interaction.user.username : 'System'}` })
                    .setTimestamp();
                
                channel.send({ embeds: [embed] }).catch(err => console.error(`Error sending log: ${err.message}`));
            }
        } catch (error) {
            // Silently ignore
        }
    }
}

async function loadLogChannelIds(db, client, logEvent) {
    if (!db) return;
    try {
        const result = await db.query('SELECT log_type, channel_id FROM log_channels');
        client.logChannelIds = result.rows.reduce((acc, row) => {
            acc[row.log_type] = row.channel_id;
            return acc;
        }, {});
    } catch (e) {
        logEvent('deployment', `Failed to load log channel IDs: ${e.message}`);
        client.logChannelIds = {};
    }
}

function getCommandsByModule() {
    const modules = {
        'Central': [],
        'StarPoints': [],
        'Marketplace': []
    };
    
    const extractCommands = (commandMap, moduleName) => {
        for (const [name, cmd] of commandMap) {
            if (!cmd.data) continue;
            
            // CORREÇÃO: Converte o objeto de comando para JSON para garantir que as opções sejam carregadas
            const commandData = cmd.data.toJSON ? cmd.data.toJSON() : cmd.data; 

            const baseCommand = { name: name, description: commandData.description };
            
            if (name !== 'help' && !modules[moduleName].some(c => c.name === name)) {
                modules[moduleName].push(baseCommand);
            }
            
            if (commandData.options) { // Agora usa commandData.options
                for (const option of commandData.options) { // E itera sobre commandData.options
                    if (option.type === 1) { // Subcommand
                        modules[moduleName].push({
                            name: `${name} ${option.name}`,
                            description: option.description
                        });
                    } else if (option.type === 2) { // Subcommand Group
                        if (option.options) {
                            for (const subOption of option.options) {
                                modules[moduleName].push({
                                    name: `${name} ${option.name} ${subOption.name}`,
                                    description: subOption.description
                                });
                            }
                        }
                    }
                }
            }
        }
    };
    
    // Commands added manually to Central that aren't base commands.
    const centralManualCommands = [
        { name: 'central setlogchannel', description: 'Sets the channel for bot activity logs.' },
        { name: 'central permissions bulk', description: 'Opens modal to manage bulk permissions.' },
        { name: 'central permissions view', description: 'Views all access rules for a specific command.' },
        { name: 'central permissions grantallrole', description: 'Grants access to ALL commands for a specific role.' },
        { name: 'central permissions revokeentity', description: 'Revokes all custom permissions for a user or role.' },
        { name: 'central permissions revokecommand', description: 'Revokes all custom permissions for a specific command.' },
        { name: 'central accesspool create', description: 'Creates a new access pool' },
        { name: 'central accesspool undo', description: 'Removes an existing access pool' },
        { name: 'central accesspool list', description: 'Lists all existing access pools' },
        { name: 'central permissionsgroup', description: 'Grant bulk permissions to roles (Interactive)' },
        { name: 'central setcommandsgroups', description: 'Interactively creates a new Access Pool (command group).' },
        { name: 'central help', description: 'Lists all available commands.' },
        { name: 'central testbot', description: 'Executes basic health checks.' },
    ];
    modules['Central'].push(...centralManualCommands);
    
    extractCommands(client.marketplaceCommands, 'Marketplace');
    extractCommands(client.pointsCommands, 'StarPoints');
    
    return modules;
}

function getCommandList() {
    const commands = [];
    
    const modules = getCommandsByModule();
    for (const [moduleName, commandList] of Object.entries(modules)) {
        commands.push(...commandList.map(cmd => ({ ...cmd, module: moduleName })));
    }
    
    return Array.from(new Map(commands.map(cmd => [cmd.name, cmd])).values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function checkCommandPermission(interaction, commandName, db) {
    if (interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return true;
    }
    
    // --- INÍCIO DA CORREÇÃO CENTRALIZADA DE PERMISSÃO: Permite apenas comandos de leitura pública do StarPoints ---
    // Comandos que são explicitamente permitidos a todos os usuários (leituras públicas)
    const PUBLIC_STARPOINTS_COMMANDS = ['starpoints leaderboard', 'starpoints listpoints'];

    if (commandName.startsWith('starpoints') && PUBLIC_STARPOINTS_COMMANDS.includes(commandName)) {
        return true;
    }
    // FIM DA CORREÇÃO: Todos os outros comandos 'starpoints' (add, remove, transfer, etc.) 
    // agora exigirão permissão explícita (ALLOW) via /central permissions.

    let permissionCommandName = commandName;

    if (commandName === 'central') {
        const sub = interaction.options.getSubcommand(false);
        const group = interaction.options.getSubcommandGroup(false);

        if (sub === 'help') return true;
        
        if (group === 'permissions') {
            const subSub = interaction.options.getSubcommand();
            if (subSub === 'bulk') permissionCommandName = 'central permissions bulk';
            else if (subSub === 'view') permissionCommandName = 'central permissions view';
            else if (subSub === 'grantallrole') permissionCommandName = 'central permissions grantallrole';
            else if (subSub === 'revokeentity') permissionCommandName = 'central permissions revokeentity';
            else if (subSub === 'revokecommand') permissionCommandName = 'central permissions revokecommand';
            else permissionCommandName = 'centralpermissions';
        } else if (group === 'accesspool') {
            const subSub = interaction.options.getSubcommand();
            if (subSub === 'create') permissionCommandName = 'central accesspool create';
            else if (subSub === 'undo') permissionCommandName = 'central accesspool undo';
            else if (subSub === 'list') permissionCommandName = 'central accesspool list';
            else permissionCommandName = 'centralaccesspool';
        } else if (sub === 'setlogchannel') {
            permissionCommandName = 'central setlogchannel';
        } else if (sub === 'testbot') {
            permissionCommandName = 'central testbot';
        } else if (sub === 'permissionsgroup') {
            permissionCommandName = 'central permissionsgroup';
        } else if (sub === 'setcommandsgroups') {
            permissionCommandName = 'central setcommandsgroups';
        } else {
            permissionCommandName = 'central';
        }
    }
    
    const userResult = await db.query(`
        SELECT permission FROM command_permissions 
        WHERE command_name = $1 AND entity_id = $2 AND permission_type = 'user'
    `, [permissionCommandName, interaction.user.id]);
    const userPerm = userResult.rows[0];

    if (userPerm) return userPerm.permission === 'allow';

    const roleIds = interaction.member.roles.cache.map(r => r.id);
    if (roleIds.length > 0) {
        const placeholders = roleIds.map((_, i) => `$${i + 2}`).join(',');
        const roleResult = await db.query(`
            SELECT permission FROM command_permissions 
            WHERE command_name = $1 AND entity_id IN (${placeholders}) AND permission_type = 'role'
        `, [permissionCommandName, ...roleIds]);
        
        if (roleResult.rows.some(p => p.permission === 'deny')) return false;
        if (roleResult.rows.some(p => p.permission === 'allow')) return true;
    }
    
    // Se não for admin, não for comando público e não tiver permissão explícita no DB, nega.
    return false;
}

async function processBulkPermissions(action, input, interaction, db) {
    const lines = input.split('\n').filter(l => l.trim() !== '');
    const commandOrPools = [];
    const entitiesToProcess = [];
    let parsingCommands = true;

    for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.startsWith('/') || trimmed.startsWith('$')) {
            if (!parsingCommands && entitiesToProcess.length > 0) continue;
            commandOrPools.push(trimmed);
        } else if (trimmed.startsWith('@') || trimmed.startsWith('<@')) {
            parsingCommands = false;
            let idCandidate = trimmed.startsWith('@') ? trimmed.substring(1).trim() : trimmed;
            idCandidate = idCandidate.replace(/<@!?|>/g, '').replace('<@&', '').trim();
            if (idCandidate.length >= 17 && idCandidate.length <= 20 && /^\d+$/.test(idCandidate)) {
                entitiesToProcess.push(idCandidate);
            }
        }
    }
    
    if (commandOrPools.length === 0) {
        return ["No valid command or Access Pool found. Check if you used / or $."];
    }
    
    const commandMap = {
        'central setlogchannel': 'central setlogchannel',
        'central permissions bulk': 'central permissions bulk',
        'central permissions view': 'central permissions view',
        'central permissions grantallrole': 'central permissions grantallrole',
        'central permissions revokeentity': 'central permissions revokeentity',
        'central permissions revokecommand': 'central permissions revokecommand',
        'central accesspool create': 'central accesspool create',
        'central accesspool undo': 'central accesspool undo',
        'central accesspool list': 'central accesspool list',
        'central permissionsgroup': 'central permissionsgroup',
        'central setcommandsgroups': 'central setcommandsgroups',
        'central help': 'central help',
        'central testbot': 'central testbot'
    };
    
    const commandsToProcess = [];
    for (const commandOrPool of commandOrPools) {
        if (commandOrPool.startsWith('$')) {
            const poolName = commandOrPool.substring(1).toLowerCase();
            const poolResult = await db.query("SELECT commands FROM access_pools WHERE pool_name = $1", [poolName]);
            if (poolResult.rows[0]) {
                commandsToProcess.push(...JSON.parse(poolResult.rows[0].commands));
            }
        } else if (commandOrPool.startsWith('/')) {
            let cmdName = commandOrPool.substring(1).toLowerCase().trim();
            if (commandMap[cmdName]) cmdName = commandMap[cmdName];
            commandsToProcess.push(cmdName);
        }
    }
    
    const validCommands = [...new Set(commandsToProcess)];
    let results = [];
    
    if (validCommands.length === 0) {
        return ["No valid command or Access Pool found after resolution."];
    }
    
    const allValidCommands = getCommandList().map(c => c.name);
    
    await db.query('BEGIN');

    try {
        for (const entityId of entitiesToProcess) {
            let entity, entityType, entityName;

            const member = interaction.guild.members.cache.get(entityId);
            if (member) {
                entity = member;
                entityType = 'user';
                entityName = member.user.username;
            } else {
                const role = interaction.guild.roles.cache.get(entityId);
                if (role) {
                    entity = role;
                    entityType = 'role';
                    entityName = role.name;
                }
            }
            
            if (!entity) {
                results.push(`Entity **${entityId}** not found.`);
                continue;
            }
            
            for (const cmdName of validCommands) {
                if (!allValidCommands.includes(cmdName)) {
                    results.push(`Command /${cmdName} does not exist. Ignored.`);
                    continue;
                }
                
                await db.query(`
                    INSERT INTO command_permissions (command_name, entity_id, permission_type, permission) 
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (command_name, entity_id, permission_type) DO UPDATE
                    SET permission = $4
                `, [cmdName, entity.id, entityType, action]);
                
                results.push(`**/${cmdName}** for ${entityType} **${entityName}** (${action.toUpperCase()})`);
                logEvent('system', `Permission '${action}' applied to /${cmdName} for ${entityType} ${entityName}`, interaction);
            }
        }
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
    
    return results;
}

async function handlePermissionsGroupFlow(interaction, db, client, logEvent) {
    const customId = interaction.customId;
    
    if (customId === 'PG_ROLE_SELECT') {
        const roleId = interaction.values[0];
        const role = interaction.guild.roles.cache.get(roleId);
        
        if (!role) return interaction.update({ content: 'Role not found.', components: [] });
        
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`PG_MODULE_SELECT:${roleId}`)
                .setPlaceholder('Select a module...')
                .addOptions([
                    { label: 'Central', description: 'System & permission commands', value: 'Central' },
                    { label: 'StarPoints', description: '$tarpoints economy system', value: 'StarPoints' },
                    { label: 'Marketplace', description: 'Item shop & trading', value: 'Marketplace' },
                    { label: 'All Modules', description: 'Grant access to all commands', value: 'All' }
                ])
        );
        
        return interaction.update({
            content: `**Step 2/3: Module Selection**\n\nRole: **${role.name}**\n\nWhich module's commands should this role access?`,
            components: [row]
        });
    }
    
    if (customId.startsWith('PG_MODULE_SELECT:')) {
        const roleId = customId.split(':')[1];
        const moduleName = interaction.values[0];
        const role = interaction.guild.roles.cache.get(roleId);
        
        if (moduleName === 'All') {
            const allCommands = getCommandList().map(c => c.name);
            
            await db.query('BEGIN');
            try {
                for (const cmdName of allCommands) {
                    await db.query(`
                        INSERT INTO command_permissions (command_name, entity_id, permission_type, permission) 
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (command_name, entity_id, permission_type) DO UPDATE
                        SET permission = $4
                    `, [cmdName, roleId, 'role', 'allow']);
                }
                await db.query('COMMIT');
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            }
            
            logEvent('system', `Granted ALLOW permission to ALL commands for role ${role.name} via interactive flow.`, interaction);
            
            return interaction.update({
                content: `**Permissions Granted Successfully**\n\nRole: **${role.name}**\nModule: **All Modules**\n\n${allCommands.length} command(s) granted.`,
                components: []
            });
        }
        
        const moduleCommands = getCommandsByModule()[moduleName] || [];
        
        if (moduleCommands.length === 0) {
            return interaction.update({ content: `No commands found for module **${moduleName}**.`, components: [] });
        }
        
        const options = moduleCommands.map(cmd => ({
            label: cmd.name.length > 100 ? cmd.name.substring(0, 97) + '...' : cmd.name,
            description: cmd.description.length > 100 ? cmd.description.substring(0, 97) + '...' : cmd.description,
            value: cmd.name
        }));
        
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`PG_COMMAND_SELECT:${roleId}:${moduleName}`)
                .setPlaceholder('Select commands...')
                .setMinValues(1)
                .setMaxValues(Math.min(25, options.length))
                .addOptions(options.slice(0, 25))
        );
        
        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`PG_GRANT_ALL:${roleId}:${moduleName}`)
                .setLabel(`Grant All ${moduleName} Commands`)
                .setStyle(ButtonStyle.Success)
        );
        
        return interaction.update({
            content: `**Step 3/3: Command Selection**\n\nRole: **${role.name}**\nModule: **${moduleName}**\n\nSelect specific commands or grant all:`,
            components: [row, buttonRow]
        });
    }
    
    if (customId.startsWith('PG_COMMAND_SELECT:')) {
        const [, roleId, moduleName] = customId.split(':');
        const selectedCommands = interaction.values;
        const role = interaction.guild.roles.cache.get(roleId);
        
        await db.query('BEGIN');
        try {
            for (const cmdName of selectedCommands) {
                await db.query(`
                    INSERT INTO command_permissions (command_name, entity_id, permission_type, permission) 
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (command_name, entity_id, permission_type) DO UPDATE
                    SET permission = $4
                `, [cmdName, roleId, 'role', 'allow']);
            }
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        
        logEvent('system', `Granted ALLOW to ${selectedCommands.length} ${moduleName} commands for role ${role.name}.`, interaction);
        
        return interaction.update({
            content: `**Permissions Granted**\n\nRole: **${role.name}**\nModule: **${moduleName}**\n\nCommands:\n${selectedCommands.map(c => `- \`/${c}\``).join('\n')}`,
            components: []
        });
    }
    
    if (customId.startsWith('PG_GRANT_ALL:')) {
        const [, roleId, moduleName] = customId.split(':');
        const role = interaction.guild.roles.cache.get(roleId);
        const moduleCommands = getCommandsByModule()[moduleName] || [];
        
        await db.query('BEGIN');
        try {
            for (const cmd of moduleCommands) {
                await db.query(`
                    INSERT INTO command_permissions (command_name, entity_id, permission_type, permission) 
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (command_name, entity_id, permission_type) DO UPDATE
                    SET permission = $4
                `, [cmd.name, roleId, 'role', 'allow']);
            }
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        
        logEvent('system', `Granted ALLOW to ALL ${moduleName} commands for role ${role.name}.`, interaction);
        
        return interaction.update({
            content: `**Permissions Granted**\n\nRole: **${role.name}**\nModule: **${moduleName}**\n\n${moduleCommands.length} command(s) granted.`,
            components: []
        });
    }
}

async function handleCommandGroupFlow(interaction, db, client, logEvent) {
    const customId = interaction.customId;
    
    // CG_MODULE_SELECT (Step 1: Module Selection)
    if (customId === 'CG_MODULE_SELECT') {
        const selectedModule = interaction.values[0];
        const allCommands = getCommandsByModule();
        let commands;

        if (selectedModule === 'All') {
            commands = getCommandList();
        } else {
            commands = allCommands[selectedModule] || [];
        }

        if (commands.length === 0) {
            return interaction.update({
                content: `No commands found for module **${selectedModule}**. Please select another module.`,
                components: [interaction.message.components[0]]
            });
        }
        
        // Prepare options for the command select menu (max 25)
        const options = commands.map(cmd => ({
            label: `/${cmd.name}`.length > 100 ? `/${cmd.name}`.substring(0, 97) + '...' : `/${cmd.name}`,
            description: cmd.description.length > 100 ? cmd.description.substring(0, 97) + '...' : cmd.description,
            value: cmd.name
        })).slice(0, 25); // Limit to 25 options

        const selectMenuRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`CG_COMMAND_SELECT:${selectedModule}`)
                .setPlaceholder('Select commands (max 25)...')
                .setMinValues(1)
                .setMaxValues(options.length)
                .addOptions(options)
        );
        
        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`CG_PROCEED_NAME:0:${selectedModule}`) // Format: CG_PROCEED_NAME:<count>:<module> (0 commands initially selected)
                .setLabel('Proceed to Name Group')
                .setStyle(ButtonStyle.Success)
                .setDisabled(true), // Disabled until a command is selected
            new ButtonBuilder()
                .setCustomId('CG_CANCEL_FLOW')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
        );

        return interaction.update({
            content: `**Access Pool Creator: Step 2/3 (Command Selection)**\n\nModule: **${selectedModule}**\n\nSelected Commands: **0**\n\nSelect commands from the list below and click 'Proceed to Name Group' when finished.`,
            components: [selectMenuRow, buttonRow]
        });
    }
    
    // CG_COMMAND_SELECT (State Update - updates the button label and state, but does not proceed yet)
    if (customId.startsWith('CG_COMMAND_SELECT:')) {
        const [, selectedModule] = customId.split(':');
        const selectedCommands = interaction.values;
        const currentMessage = interaction.message;
        
        const updatedButtonRow = ActionRowBuilder.from(currentMessage.components.find(c => c.components[0].customId && c.components[0].customId.startsWith('CG_PROCEED_NAME')));
        const proceedButton = ButtonBuilder.from(updatedButtonRow.components[0])
            .setDisabled(selectedCommands.length === 0)
            .setCustomId(`CG_PROCEED_NAME:${selectedCommands.join('|')}:${selectedModule}`); // Store selected commands in the button's custom ID

        const cancelButton = ButtonBuilder.from(updatedButtonRow.components[1]);
        
        // Update the ephemeral message with the new count and enable/disable the button
        return interaction.update({
            content: `**Access Pool Creator: Step 2/3 (Command Selection)**\n\nModule: **${selectedModule}**\n\nSelected Commands: **${selectedCommands.length}**\n\nSelect commands from the list below and click 'Proceed to Name Group' when finished.`,
            components: [ActionRowBuilder.from(currentMessage.components[0]), new ActionRowBuilder().addComponents(proceedButton, cancelButton)]
        });
    }

    // CG_PROCEED_NAME (Step 3: Open Naming Modal)
    if (customId.startsWith('CG_PROCEED_NAME:')) {
        const [, commandsString, moduleName] = customId.split(':');
        const selectedCommands = commandsString.split('|').filter(c => c.length > 0);
        
        if (selectedCommands.length === 0) {
            return interaction.reply({ content: 'Please select at least one command before proceeding.', flags: EPHEMERAL_FLAG });
        }
        
        const commandsForModal = JSON.stringify(selectedCommands);
        
        const modal = new ModalBuilder()
            .setCustomId(`CG_NAME_MODAL:${moduleName}:${commandsForModal}`)
            .setTitle("Access Pool Naming");

        const groupNameInput = new TextInputBuilder()
            .setCustomId("groupNameInput")
            .setLabel("Enter the name for this Access Pool")
            .setPlaceholder("e.g., moderator_commands")
            .setStyle(TextInputStyle.Short)
            .setMinLength(3)
            .setMaxLength(30)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(groupNameInput));

        // Use interaction.showModal for the naming step
        return interaction.showModal(modal);
    }
    
    // CG_CANCEL_FLOW
    if (customId === 'CG_CANCEL_FLOW') {
        return interaction.update({ content: 'Access Pool creation cancelled.', components: [] });
    }
    
    // CG_NAME_MODAL (Modal Submission - Final Step)
    if (interaction.isModalSubmit() && customId.startsWith('CG_NAME_MODAL:')) {
        await interaction.deferReply({ flags: EPHEMERAL_FLAG });
        
        const [, moduleName, commandsJson] = customId.split(':');
        const groupName = interaction.fields.getTextInputValue("groupNameInput").toLowerCase().replace(/\s/g, '_');
        
        const commandsToStore = JSON.parse(commandsJson);
        
        if (!/^[a-z0-9_]+$/.test(groupName)) {
            return interaction.editReply("Error: Group name can only contain lowercase letters, numbers, and underscores.");
        }
        
        try {
            // Check if pool already exists
            const existingPool = await db.query("SELECT * FROM access_pools WHERE pool_name = $1", [groupName]);
            if (existingPool.rows.length > 0) {
                 return interaction.editReply(`Error: Access Pool **${groupName}** already exists. Please choose a different name.`);
            }

            await db.query(`
                INSERT INTO access_pools (pool_name, commands) 
                VALUES ($1, $2)
            `, [groupName, JSON.stringify(commandsToStore)]);
            
            logEvent('system', `Created Access Pool ${groupName} with ${commandsToStore.length} commands.`, interaction);

            const commandListString = commandsToStore.map(c => `\`/${c}\``).join(', ');
            
            return interaction.editReply(`**Access Pool Creation Completed!**\n\nGroup Name: **${groupName}**\nCommands Added: ${commandsToStore.length}\n\nCommands: ${commandListString}`);

        } catch (error) {
            logEvent('deployment', `Error creating Access Pool ${groupName}: ${error.message}`, interaction);
            return interaction.editReply(`An unexpected error occurred during group creation. \`Error: ${error.message}\``);
        }
    }
}

function setupCentralCommands(client, db) {
    const centralCommand = {
        data: new SlashCommandBuilder()
            .setName("central")
            .setDescription("Centralized management and system commands for CommanderBOT.") 
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(sub => 
                sub.setName("setlogchannel")
                    .setDescription("Sets the channel for bot activity logs.")
                    .addStringOption(opt => 
                        opt.setName("log_type")
                            .setDescription("The type of log.")
                            .setRequired(true)
                            .addChoices(
                                { name: 'System Logs', value: 'system' },
                                { name: 'Marketplace Logs', value: 'marketplace' },
                                { name: 'StarPoints Logs', value: 'starpoints' },
                                { name: 'Deployment Logs', value: 'deployment' },
                                { name: 'Clear Log Channel', value: 'clear' }
                            )
                    )
                    .addChannelOption(opt => opt.setName("channel").setDescription("The channel to send logs to."))
            )
            .addSubcommandGroup(group => 
                group.setName("permissions")
                    .setDescription("Manages command access permissions.")
                    .addSubcommand(sub => sub.setName("bulk").setDescription("Opens modal to manage bulk permissions."))
                    .addSubcommand(sub => 
                        sub.setName("view")
                            .setDescription("Views all access rules for a specific command.")
                            .addStringOption(opt => opt.setName("command_name").setDescription("The command name").setRequired(true))
                    )
                    .addSubcommand(sub => 
                        sub.setName("grantallrole")
                            .setDescription("Grants access to ALL commands for a specific role.")
                            .addRoleOption(opt => opt.setName("role").setDescription("The role").setRequired(true))
                    )
                    .addSubcommand(sub => 
                        sub.setName("revokeentity")
                            .setDescription("Revokes all custom permissions for a user or role.")
                            .addStringOption(opt => opt.setName("entity_id").setDescription("User/Role ID").setRequired(true))
                    )
                    .addSubcommand(sub => 
                        sub.setName("revokecommand")
                            .setDescription("Revokes all custom permissions for a specific command.")
                            .addStringOption(opt => opt.setName("command_name").setDescription("Command name").setRequired(true))
                    )
            )
            .addSubcommandGroup(group => group.setName("accesspool")
                    .setDescription("Manages command groups for permission assignments.")
                    .addSubcommand(sub => 
                        sub.setName("create")
                            .setDescription("Creates a new access pool")
                            .addStringOption(opt => opt.setName("name").setDescription("Pool name").setRequired(true))
                            .addStringOption(opt => opt.setName("commands").setDescription("Commands separated by spaces").setRequired(true))
                    )
                    .addSubcommand(sub => 
                        sub.setName("undo")
                            .setDescription("Removes an existing access pool")
                            .addStringOption(opt => opt.setName("name").setDescription("Pool name").setRequired(true))
                    )
                    .addSubcommand(sub => sub.setName("list").setDescription("Lists all existing access pools"))
            )
            .addSubcommand(sub => 
                sub.setName("permissionsgroup")
                    .setDescription("Grant bulk permissions to roles (Interactive)")
            )
            .addSubcommand(sub => 
                sub.setName("setcommandsgroups") // NOVO COMANDO IMPLEMENTADO
                    .setDescription("Interactively creates a new Access Pool (command group).")
            )
            .addSubcommand(sub => sub.setName("help").setDescription("Lists all available commands."))
            .addSubcommand(sub => sub.setName("testbot")
                    .setDescription("Runs basic health checks.")
                    .addStringOption(opt => opt.setName("module")
                            .setDescription("Filters tests by module.")
                            .setRequired(true)
                            .addChoices(
                                { name: 'All Modules', value: 'all' },
                                { name: 'Central (System)', value: 'central' },
                                { name: 'Marketplace', value: 'marketplace' },
                                { name: 'StarPoints', value: 'starpoints' }
                            )
                    )
            ),
        
        async execute(interaction, db, client, logEvent) {
            const subCommand = interaction.options.getSubcommand();
            const subGroup = interaction.options.getSubcommandGroup(false);

            if (subCommand === 'setlogchannel') {
                const logType = interaction.options.getString("log_type");
                const channel = interaction.options.getChannel("channel");
                
                if (logType === 'clear') {
                    await db.query("DELETE FROM log_channels");
                    client.logChannelIds = {};
                    return interaction.editReply(`All log channels cleared.`);
                }

                if (!channel) {
                    return interaction.editReply("Channel not specified.");
                }

                await db.query(`
                    INSERT INTO log_channels (log_type, channel_id) 
                    VALUES ($1, $2)
                    ON CONFLICT (log_type) DO UPDATE SET channel_id = $2
                `, [logType, channel.id]);
                
                client.logChannelIds[logType] = channel.id;
                return interaction.editReply(`Logs for **${logType.toUpperCase()}** will now be sent to ${channel}.`);
            }

            if (subCommand === 'permissionsgroup') {
                const row = new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId('PG_ROLE_SELECT')
                        .setPlaceholder('Select a role...')
                        .setMinValues(1)
                        .setMaxValues(1)
                );
                
                // CORREÇÃO: Usa interaction.reply para comandos que pulam o deferimento global
                return interaction.reply({
                    content: '**Step 1/3: Role Selection**\n\nSelect the role that will receive command permissions:',
                    components: [row],
                    flags: EPHEMERAL_FLAG
                });
            }
            
            // NOVO COMANDO: setcommandsgroups
            if (subCommand === 'setcommandsgroups') {
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('CG_MODULE_SELECT')
                        .setPlaceholder('Select a module to filter commands...')
                        .addOptions([
                            { label: 'Central', description: 'System & permission commands', value: 'Central' },
                            { label: 'StarPoints', description: '$tarpoints economy system', value: 'StarPoints' },
                            { label: 'Marketplace', description: 'Item shop & trading', value: 'Marketplace' },
                            { label: 'All Modules', description: 'Select commands from all modules', value: 'All' }
                        ])
                );
                
                // Usa interaction.reply para comandos que pulam o deferimento global
                return interaction.reply({
                    content: '**Access Pool Creator: Step 1/3 (Module)**\n\nSelect the module you want to pull commands from:',
                    components: [row],
                    flags: EPHEMERAL_FLAG
                });
            }

            if (subGroup === 'permissions' && subCommand === 'bulk') {
                const modal = new ModalBuilder()
                    .setCustomId("bulkPermissionsModal")
                    .setTitle("Manage Bulk Permissions");

                const actionSelect = new TextInputBuilder()
                    .setCustomId("bulkAction")
                    .setLabel("Action: ALLOW or DENY")
                    .setPlaceholder("Type 'allow' or 'deny'")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                    
                const input = new TextInputBuilder()
                    .setCustomId("bulkInput")
                    .setLabel("Commands/Pools and Users/Roles")
                    .setPlaceholder("Format: /command OR $pool_name, then @user OR @role")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(actionSelect),
                    new ActionRowBuilder().addComponents(input)
                );

                return interaction.showModal(modal);
            }
            
            if (subGroup === 'permissions' && subCommand === 'view') {
                const cmdName = interaction.options.getString("command_name").toLowerCase().replace(/^\//, '').trim();
                
                const commandMap = {
                    'central setlogchannel': 'central setlogchannel',
                    'central permissions bulk': 'central permissions bulk',
                    'central permissions view': 'central permissions view',
                    'central permissions grantallrole': 'central permissions grantallrole',
                    'central permissions revokeentity': 'central permissions revokeentity',
                    'central permissions revokecommand': 'central permissions revokecommand',
                    'central accesspool create': 'central accesspool create',
                    'central accesspool undo': 'central accesspool undo',
                    'central accesspool list': 'central accesspool list',
                    'central permissionsgroup': 'central permissionsgroup',
                    'central setcommandsgroups': 'central setcommandsgroups',
                    'central help': 'central help',
                    'central testbot': 'central testbot'
                };
                const dbCommandName = commandMap[cmdName] || cmdName;
                
                const permsResult = await db.query("SELECT entity_id, permission_type, permission FROM command_permissions WHERE command_name = $1 ORDER BY permission_type", [dbCommandName]);

                if (permsResult.rows.length === 0) {
                    return interaction.editReply(`No custom permissions found for **/${dbCommandName}**.`);
                }
                
                let userPerms = 'None';
                let rolePerms = 'None';
                
                for (const p of permsResult.rows) {
                    let name = p.entity_id;
                    
                    if (p.permission_type === 'user') {
                        try {
                            const user = await client.users.fetch(p.entity_id);
                            name = user.username;
                        } catch (e) {}
                        userPerms = userPerms === 'None' ? '' : userPerms;
                        userPerms += `\n> **${name}** - ${p.permission.toUpperCase()}`;
                    } else if (p.permission_type === 'role') {
                        const role = interaction.guild.roles.cache.get(p.entity_id);
                        if (role) name = role.name;
                        rolePerms = rolePerms === 'None' ? '' : rolePerms;
                        rolePerms += `\n> **${name}** - ${p.permission.toUpperCase()}`;
                    }
                }
                
                const embed = new EmbedBuilder()
                    .setTitle(`Access Rules for /${dbCommandName}`)
                    .setColor(0x3498db)
                    .addFields(
                        { name: 'User Overrides', value: userPerms || 'None', inline: false },
                        { name: 'Role Permissions', value: rolePerms || 'None', inline: false }
                    )
                    .setFooter({ text: 'Admins bypass all rules.' });

                return interaction.editReply({ embeds: [embed] });
            }
            
            if (subGroup === 'permissions' && subCommand === 'grantallrole') {
                const role = interaction.options.getRole("role");
                const allCommands = getCommandList().map(c => c.name);
                
                await db.query('BEGIN');
                try {
                    for (const cmdName of allCommands) {
                        await db.query(`
                            INSERT INTO command_permissions (command_name, entity_id, permission_type, permission) 
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (command_name, entity_id, permission_type) DO UPDATE SET permission = $4
                        `, [cmdName, role.id, 'role', 'allow']);
                    }
                    await db.query('COMMIT');
                } catch (error) {
                    await db.query('ROLLBACK');
                    throw error;
                }
                
                logEvent('system', `Granted ALLOW to ALL commands for role ${role.name}`, interaction);
                return interaction.editReply(`Granted **ALLOW** for **ALL** commands to role **${role.name}**.`);
            }
            
            if (subGroup === 'permissions' && subCommand === 'revokeentity') {
                const entityInput = interaction.options.getString("entity_id").replace(/<@!?|>/g, '').replace('<@&', '').trim();
                let entityType = '', entityName = '';
                
                const member = interaction.guild.members.cache.get(entityInput);
                if (member) {
                    entityType = 'user';
                    entityName = member.user.username;
                } else {
                    const role = interaction.guild.roles.cache.get(entityInput);
                    if (role) {
                        entityType = 'role';
                        entityName = role.name;
                    }
                }
                
                if (!entityType) return interaction.editReply(`Entity **${entityInput}** not found.`);
                
                const deleteResult = await db.query("DELETE FROM command_permissions WHERE entity_id = $1 AND permission_type = $2", [entityInput, entityType]);
                logEvent('system', `Revoked ALL permissions for ${entityType} ${entityName}`, interaction);
                return interaction.editReply(`Revoked all custom permissions for ${entityType} **${entityName}** (${deleteResult.rowCount} entries).`);
            }

            if (subGroup === 'permissions' && subCommand === 'revokecommand') {
                const cmdName = interaction.options.getString("command_name").toLowerCase().replace(/^\//, '').trim();
                const commandMap = {
                    'central setlogchannel': 'central setlogchannel',
                    'central permissions bulk': 'central permissions bulk',
                    'central permissions view': 'central permissions view',
                    'central permissions grantallrole': 'central permissions grantallrole',
                    'central permissions revokeentity': 'central permissions revokeentity',
                    'central permissions revokecommand': 'central permissions revokecommand',
                    'central accesspool create': 'central accesspool create',
                    'central accesspool undo': 'central accesspool undo',
                    'central accesspool list': 'central accesspool list',
                    'central permissionsgroup': 'central permissionsgroup',
                    'central setcommandsgroups': 'central setcommandsgroups',
                    'central help': 'central help',
                    'central testbot': 'central testbot'
                };
                const dbCommandName = commandMap[cmdName] || cmdName;
                
                const deleteResult = await db.query("DELETE FROM command_permissions WHERE command_name = $1", [dbCommandName]);
                logEvent('system', `Revoked ALL permissions for command /${dbCommandName}`, interaction);
                return interaction.editReply(`Revoked all custom permissions for **/${dbCommandName}** (${deleteResult.rowCount} entries).`);
            }

            if (subGroup === 'accesspool' && subCommand === 'create') {
                const poolName = interaction.options.getString("name").toLowerCase().replace(/\s/g, '_');
                const commandsInput = interaction.options.getString("commands");
                
                if (!/^[a-z0-9_]+$/.test(poolName)) {
                    return interaction.editReply("Pool name can only contain lowercase letters, numbers, and underscores.");
                }
                
                const rawCommands = commandsInput.split(/\s+/).filter(c => c.startsWith('/'));
                const allValidCommands = getCommandList().map(c => c.name);
                const validCommands = rawCommands.map(cmd => cmd.substring(1).toLowerCase().trim())
                    .filter(name => allValidCommands.includes(name));
                
                if (validCommands.length === 0) {
                    return interaction.editReply("No valid commands found.");
                }
                
                await db.query(`
                    INSERT INTO access_pools (pool_name, commands) 
                    VALUES ($1, $2) ON CONFLICT (pool_name) DO UPDATE SET commands = $2
                `, [poolName, JSON.stringify(validCommands)]);
                
                logEvent('system', `Created access pool ${poolName} with ${validCommands.length} commands.`, interaction);
                return interaction.editReply(`Access Pool **${poolName}** created with ${validCommands.length} commands.`);
            }
            
            if (subGroup === 'accesspool' && subCommand === 'undo') {
                const poolName = interaction.options.getString("name").toLowerCase().replace(/\s/g, '_');
                const deleteResult = await db.query("DELETE FROM access_pools WHERE pool_name = $1", [poolName]);
                
                if (deleteResult.rowCount > 0) {
                    logEvent('system', `Removed access pool ${poolName}.`, interaction);
                    return interaction.editReply(`Access Pool **${poolName}** removed.`);
                } else {
                    return interaction.editReply(`Access Pool **${poolName}** not found.`);
                }
            }
            
            if (subGroup === 'accesspool' && subCommand === 'list') {
                const result = await db.query("SELECT pool_name, commands FROM access_pools ORDER BY pool_name");

                if (result.rows.length === 0) {
                    return interaction.editReply("No access pools found.");
                }
                
                const embed = new EmbedBuilder().setTitle("Existing Access Pools").setColor(0x3498db);
                    
                result.rows.forEach(row => {
                    const commands = JSON.parse(row.commands);
                    embed.addFields({ 
                        name: `**$${row.pool_name}** (${commands.length} commands)`, 
                        value: commands.map(c => `\`/${c}\``).slice(0, 5).join(', ') + (commands.length > 5 ? '...' : ''),
                        inline: false 
                    });
                });
                
                return interaction.editReply({ embeds: [embed] });
            }

            if (subCommand === 'help') {
                const modulesByCommands = getCommandsByModule();
                const availableModules = {};
                
                for (const [moduleName, commands] of Object.entries(modulesByCommands)) {
                    const accessibleCommands = [];
                    for (const cmd of commands) {
                        if (await checkCommandPermission(interaction, cmd.name, db)) {
                            accessibleCommands.push(cmd);
                        }
                    }
                    if (accessibleCommands.length > 0) {
                        availableModules[moduleName] = accessibleCommands;
                    }
                }
                
                if (Object.keys(availableModules).length === 0) {
                    return interaction.editReply("You don't have access to any commands.");
                }
                
                const embed = new EmbedBuilder()
                    .setTitle("CommanderBOT - Available Commands")
                    .setDescription("Commands organized by module.")
                    .setColor(0x00ff00)
                    .setFooter({ text: 'Administrators have access to all commands.' })
                    .setTimestamp();
                
                for (const [moduleName, commands] of Object.entries(availableModules)) {
                    const uniqueBaseCommands = [...new Set(commands.map(c => c.name.split(' ')[0]))];
                    const commandList = uniqueBaseCommands.map(cmd => `\`/${cmd}\``).join(', ');
                    
                    embed.addFields({
                        name: `${moduleName} Module`,
                        value: `${commandList}\n*${commands.length} command(s) available*`,
                        inline: false
                    });
                }
                
                return interaction.editReply({ embeds: [embed] });
            }
            
            if (subCommand === 'testbot') {
                const moduleFilter = interaction.options.getString("module");
                const tests = [];
                let overallStatus = true;
                
                if (moduleFilter === 'central' || moduleFilter === 'all') {
                    try {
                        const result = await db.query("SELECT channel_id FROM log_channels WHERE log_type = 'deployment'");
                        tests.push({ name: "Deployment Log Config", status: !!result.rows[0], message: result.rows[0] ? `Configured` : 'Not configured.' });
                        if (!result.rows[0]) overallStatus = false;
                    } catch (e) {
                        tests.push({ name: "Deployment Log Config", status: false, message: `DB Error` });
                        overallStatus = false;
                    }
                }
                
                if (moduleFilter === 'marketplace' || moduleFilter === 'all') {
                    try {
                        const result = await db.query("SELECT COUNT(*) as count FROM marketplace");
                        tests.push({ name: "Marketplace Items", status: result.rows[0].count > 0, message: `${result.rows[0].count} item(s)` });
                        if (result.rows[0].count === 0) overallStatus = false;
                    } catch (e) {
                        tests.push({ name: "Marketplace Items", status: false, message: `DB Error` });
                        overallStatus = false;
                    }
                }
                
                if (moduleFilter === 'starpoints' || moduleFilter === 'all') {
                    try {
                        const result = await db.query("SELECT COUNT(*) as count FROM usuarios");
                        tests.push({ name: "StarPoints Data", status: true, message: `${result.rows[0].count} user(s)` });
                    } catch (e) {
                        tests.push({ name: "StarPoints Data", status: false, message: `DB Error` });
                        overallStatus = false;
                    }
                }
                
                const embed = new EmbedBuilder()
                    .setTitle(`Health Check: ${moduleFilter.toUpperCase()}`)
                    .setColor(overallStatus ? 0x00ff00 : 0xff0000)
                    .setDescription(overallStatus ? "All checks passed." : "Some checks failed.")
                    .setTimestamp();
                    
                tests.forEach(test => {
                    embed.addFields({ 
                        name: test.name, 
                        value: `> Status: **${test.status ? 'PASS' : 'FAIL'}**\n> ${test.message}`, 
                        inline: false 
                    });
                });
                
                return interaction.editReply({ embeds: [embed] });
            }
        }
    };
    
    client.centralCommands.set(centralCommand.data.name, centralCommand);
}

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const allCommands = [
        ...Array.from(client.marketplaceCommands.values()).map(cmd => cmd.data.toJSON()),
        ...Array.from(client.pointsCommands.values()).map(cmd => cmd.data.toJSON()),
        ...Array.from(client.centralCommands.values()).map(cmd => cmd.data.toJSON())
    ];

    try {
        const clientId = client.user?.id || process.env.CLIENT_ID;
        await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: allCommands });
        logEvent('deployment', `Successfully reloaded ${allCommands.length} commands. (Marketplace: ${client.marketplaceCommands.size} commands)`); // Added log for Marketplace count
    } catch (error) {
        logEvent('deployment', `Failed to register commands: ${error.message}`, null);
        console.error("Failed to register commands:", error);
    }
}

(async () => {
    logEvent('deployment', 'Bot initialization started.');
    try {
        if (!process.env.PGHOST || !process.env.PGUSER || !process.env.PGDATABASE) {
            throw new Error("Missing PostgreSQL environment variables.");
        }
        
        db = new Pool({
            user: process.env.PGUSER,
            host: process.env.PGHOST,
            database: process.env.PGDATABASE,
            password: process.env.PGPASSWORD,
            port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
        
        await db.query('SELECT NOW()'); 
        logEvent('deployment', "PostgreSQL connected!");
        
        await db.query(`CREATE TABLE IF NOT EXISTS log_channels (log_type TEXT PRIMARY KEY, channel_id TEXT NOT NULL)`);
        await db.query(`CREATE TABLE IF NOT EXISTS access_pools (pool_name TEXT PRIMARY KEY, commands TEXT NOT NULL)`);
        await db.query(`CREATE TABLE IF NOT EXISTS command_permissions (command_name TEXT NOT NULL, entity_id TEXT NOT NULL, permission_type TEXT NOT NULL, permission TEXT NOT NULL, UNIQUE(command_name, entity_id, permission_type))`);

        await loadLogChannelIds(db, client, logEvent); 

        if (typeof marketplaceModule.initMarketplace === "function") {
            await marketplaceModule.initMarketplace(client, db);
        }

        if (typeof pointsModule.initPoints === "function") {
            await pointsModule.initPoints(client, db, logEvent); 
        }

        setupCentralCommands(client, db);
        await client.login(TOKEN);
        logEvent('deployment', "Bot started!");
        await registerCommands();

    } catch (error) {
        logEvent('deployment', `Error starting bot: ${error.message}`, null);
        console.error("Error starting bot:", error);
        process.exit(1);
    }
})();

client.on("ready", async () => {
    await loadLogChannelIds(db, client, logEvent); 
    logEvent('deployment', `Logged in as ${client.user.username}!`);
    client.user.setActivity(`/central help`);
});

client.on("interactionCreate", async (interaction) => {
    // Handling for non-command interactions remains the same
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('PG_')) {
            return handlePermissionsGroupFlow(interaction, db, client, logEvent);
        }
        if (interaction.customId.startsWith('CG_')) {
            return handleCommandGroupFlow(interaction, db, client, logEvent);
        }
        if (interaction.customId.startsWith('buy_') || interaction.customId.startsWith('market_page:')) {
            if (!interaction.deferred && !interaction.replied) {
                await (interaction.customId.startsWith('market_page:') ? interaction.deferUpdate() : interaction.deferReply({ flags: EPHEMERAL_FLAG }));
            }
            await marketplaceModule.handleButtonInteraction(interaction, db, client, logEvent);
            return;
        }
        if (interaction.customId.startsWith('BANK_')) {
            if (!interaction.deferred && !interaction.replied) {
                try { await interaction.deferUpdate(); } catch (e) {}
            }
            await pointsModule.handleBankInteraction(interaction, db, client, logEvent);
            return;
        }
        if (interaction.customId.startsWith('DELETE_ALL_POINTS_')) {
            if (interaction.customId.includes('REJECT')) {
                return interaction.update({ content: "Operation cancelled.", components: [] });
            }
            await pointsModule.handleAdminDeleteConfirmation(interaction, db, logEvent);
            return;
        }
        return;
    }
    
    if (interaction.isAnySelectMenu()) {
        if (interaction.customId.startsWith('PG_')) {
            return handlePermissionsGroupFlow(interaction, db, client, logEvent);
        }
        if (interaction.customId.startsWith('CG_')) {
            return handleCommandGroupFlow(interaction, db, client, logEvent);
        }
        if (interaction.customId.startsWith('BANK_TRANSFER_USER_')) {
            await pointsModule.handleBankUserSelect(interaction, db, client, logEvent);
            return;
        }
        if (interaction.customId.startsWith('scheduleRecipientType:')) {
            await pointsModule.handleScheduleRecipientTypeSelect(interaction, db, client, logEvent);
            return;
        }
        if (interaction.customId.startsWith('scheduleRecipientUser:') || interaction.customId.startsWith('scheduleRecipientRole:')) {
            await pointsModule.handleScheduleRecipientSelect(interaction, db, client, logEvent);
            return;
        }
        if (interaction.customId === 'cancelScheduleSelect') {
            await pointsModule.handleCancelScheduleSelect(interaction, db, client, logEvent);
            return;
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'bulkPermissionsModal') {
            const action = interaction.fields.getTextInputValue("bulkAction").toLowerCase();
            const input = interaction.fields.getTextInputValue("bulkInput");
            if (action !== 'allow' && action !== 'deny') {
                return interaction.reply({ content: "Invalid action.", flags: EPHEMERAL_FLAG });
            }
            await interaction.deferReply({ flags: EPHEMERAL_FLAG });
            const results = await processBulkPermissions(action, input, interaction, db);
            const fullResultText = `Bulk Permissions Results:\n\n${results.join("\n")}`;
            if (fullResultText.length > 1950) {
                const file = new AttachmentBuilder(Buffer.from(fullResultText), { name: 'results.txt' });
                return interaction.editReply({ content: `Results attached.`, files: [file] });
            }
            return interaction.editReply({ content: fullResultText }); 
        }
        if (interaction.customId.startsWith('CG_NAME_MODAL:')) {
            return handleCommandGroupFlow(interaction, db, client, logEvent);
        }
        if (interaction.customId === 'bulkPointsModal') {
            await pointsModule.handleBulkPointsModal(interaction, db, client, logEvent);
            return; 
        }
        if (interaction.customId.startsWith('BANK_TRANSFER_AMOUNT_MODAL:')) {
            await pointsModule.handleBankModalSubmit(interaction, db, client, logEvent);
            return;
        }
        if (interaction.customId === 'createScheduleModal') {
            await pointsModule.handleScheduleModalSubmit(interaction, db, client, logEvent);
            return;
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    let command;

    if (client.centralCommands.has(commandName)) {
        command = client.centralCommands.get(commandName);
    } else if (client.marketplaceCommands.has(commandName)) {
        command = client.marketplaceCommands.get(commandName);
    } else if (client.pointsCommands.has(commandName)) {
        command = client.pointsCommands.get(commandName);
    } else {
        return interaction.reply({ content: `Command /${commandName} not found.`, flags: EPHEMERAL_FLAG });
    }

    // --- INÍCIO DA CORREÇÃO: VERIFICAÇÃO CENTRALIZADA DE PERMISSÃO ---
    const sub = interaction.options.getSubcommand(false);
    const group = interaction.options.getSubcommandGroup(false);
    const fullCommandName = [commandName, group, sub].filter(Boolean).join(' ');

    const hasPermission = await checkCommandPermission(interaction, fullCommandName, db);

    if (!hasPermission) {
        const errorMessage = { content: "❌ You don't have permission to use this command." };
        // Responde adequadamente se a interação já foi respondida/adiada ou não
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(errorMessage);
            } else {
                await interaction.reply({ ...errorMessage, flags: EPHEMERAL_FLAG });
            }
        } catch (e) {
            logEvent('deployment', `Failed to send permission error for /${fullCommandName}: ${e.message}`, interaction);
        }
        return; // Interrompe a execução se não houver permissão
    }
    // --- FIM DA CORREÇÃO ---

    // A lógica de execução agora prossegue apenas se a permissão for concedida
    try {
        let isPublic = PUBLIC_REPLY_COMMANDS.includes(commandName);
        let skipDefer = false;

        if (commandName === 'starpoints') {
            const sub = interaction.options.getSubcommand(false);
            if (sub === 'leaderboard') isPublic = true;
            if (['bulk', 'bank', 'schedule', 'transfer', 'add', 'remove', 'set'].includes(sub)) skipDefer = true;
        } else if (commandName === 'central') {
            const sub = interaction.options.getSubcommand(false);
            const group = interaction.options.getSubcommandGroup(false);
            if (sub === 'permissionsgroup' || sub === 'setcommandsgroups' || (sub === 'bulk' && group === 'permissions')) {
                skipDefer = true;
            }
        } else if (commandName === 'marketplace') {
            const sub = interaction.options.getSubcommand(false);
            if (sub === 'list') isPublic = true;
        }
        
        // Adia a resposta apenas para comandos que não precisam de uma resposta imediata (como modais)
        if (!skipDefer && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: !isPublic ? EPHEMERAL_FLAG : undefined });
        }

        // Executa o comando
        await command.execute(interaction, db, client, logEvent);
        logEvent('system', `/${fullCommandName} executed by ${interaction.user.username}.`, interaction);

    } catch (error) {
        logEvent('deployment', `Error executing /${fullCommandName}: ${error.message}`, interaction);
        console.error(`Error executing /${fullCommandName}:`, error);

        const errorMessage = { content: `An error occurred: \`${error.message}\`` };
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(errorMessage);
            } else {
                await interaction.reply({ ...errorMessage, flags: EPHEMERAL_FLAG });
            }
        } catch (e) {
            console.error("Failed to send final error message:", e.message);
        }
    }
});