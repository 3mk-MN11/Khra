
/**
 * index_final.js
 * Final merged Discord bot implementing requested features:
 * - Pending transfers with 120s countdown (monitored by PROBOT messages)
 * - /set_bank, /choose_role_m, /delete_role_m commands
 * - free/offfree toggles for specific user, kings/unkings toggles for role-based free mode
 * - Giveaways: preserved embed fields + periodic countdown update + participants updates
 * - After approving an ad: create giveaway channel, send description, embed, then send plain "ق" message (only in giveaway channel)
 * - Ticket welcome message mentions configured role (if set) otherwise no mention
 *
 * Configure token via environment variable `token` and run with node.
 * Requires discord.js v14
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, Events, PermissionsBitField, ChannelType, OverwriteType } = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.token;
if (!TOKEN) { console.error('❌ token مش موجود'); process.exit(1); }

const DATA_FILE = path.join(__dirname, 'data.json');
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ guilds: {}, freeUsers: {}, kingsEnabled: {}, giveaways: {} }, null, 2), 'utf8');
function readData(){ try{ return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')) }catch(e){ return { guilds:{}, freeUsers:{}, kingsEnabled:{}, giveaways:{} } } }
function writeData(d){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8') }catch(e){ console.error('✖️ Failed to write data.json', e) } }

// Constants (adjust as needed)
const PROBOT_ID = "282859044593598464"; // external bot id to watch for transfer messages (example)
const OWNER_FREE_TARGET = '1195273386193064020'; // the specific user id for !free toggling (mn11)
const KINGS_ROLE_ID = '1395909073332863217'; // kings role id provided

function parseDuration(str){
  const m = String(str||'').trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if(!m) return null;
  const val = parseInt(m[1],10);
  const unit = m[2].toLowerCase();
  if(unit==='s') return val*1000;
  if(unit==='m') return val*60*1000;
  if(unit==='h') return val*60*60*1000;
  if(unit==='d') return val*24*60*60*1000;
  return null;
}
function formatDuration(ms){
  if(!ms || ms <= 0) return '0s';
  let secs = Math.floor(ms/1000);
  const days = Math.floor(secs / 86400); secs %= 86400;
  const hours = Math.floor(secs / 3600); secs %= 3600;
  const mins = Math.floor(secs / 60); secs %= 60;
  const parts = [];
  if(days) parts.push(days + 'd');
  if(hours) parts.push(hours + 'h');
  if(mins) parts.push(mins + 'm');
  if(secs) parts.push(secs + 's');
  return parts.join(' ');
}

// Slash commands (including new ones)
const commands = [
  new SlashCommandBuilder().setName('room_adds').setDescription('حدد روم المراجعة').addChannelOption(opt=>opt.setName('channel').setDescription('قناة').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('new_adds').setDescription('أضف/حدّث إعلانات').addStringOption(opt=>opt.setName('ads').setDescription('اسم:سعر, مفصول بفواصل').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('list_adds').setDescription('عرض الإعلانات').toJSON(),
  new SlashCommandBuilder().setName('cat_giv').setDescription('تحديد إعدادات الجيف واي لإعلان')
    .addStringOption(o=>o.setName('ad_name').setDescription('اسم الإعلان').setRequired(true))
    .addChannelOption(o=>o.setName('category').setDescription('كاتيجوري لجيف واي').setRequired(true))
    .addStringOption(o=>o.setName('prize').setDescription('الجائزة (مثال: Nitro أو 50M)').setRequired(true))
    .addStringOption(o=>o.setName('duration').setDescription('المدة: مثال 1m / 2h / 3d').setRequired(true))
    .addIntegerOption(o=>o.setName('winners').setDescription('عدد الفائزين').setRequired(true))
    .addStringOption(o=>o.setName('delete_after').setDescription('مدة حذف روم الجيف بعد انتهاءه (مثال 1d)').setRequired(false))
    .addStringOption(o=>o.setName('mention').setDescription('منشن عند فتح التذكرة').setRequired(false)
      .addChoices(
        { name: '@everyone', value: 'everyone' },
        { name: '@here', value: 'here' },
        { name: 'بدون', value: 'none' }
      )).toJSON(),
  new SlashCommandBuilder().setName('delete_room_adds').setDescription('حذف روم المراجعة المحدد').toJSON(),
  new SlashCommandBuilder().setName('room_win_giv').setDescription('حدد كاتيجوري غرف الفائزين').addChannelOption(opt=>opt.setName('category').setDescription('كاتيجوري الفائزين').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('close').setDescription('إغلاق التكت (يحذف الروم الحالي إذا كان روم فوز)').toJSON(),
  new SlashCommandBuilder().setName('set_bank').setDescription('حدد بنك التحويل (عضو يستلم)').addUserOption(o=>o.setName('user').setDescription('البنك - اختر عضو').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('choose_role_m').setDescription('اختر رتبة ليتم منشنها في رسالة الترحيب بالتكات').addRoleOption(o=>o.setName('role').setDescription('اختر رتبة').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('delete_role_m').setDescription('احذف رتبة المِنشن للترحيب').toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    const app = await rest.get(Routes.oauth2CurrentApplication());
    const appId = app?.id;
    if (!appId) throw new Error('No app id');
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (e) { console.error(e) }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => { console.log(`✅ Logged in as ${client.user.tag}`) });

/*
  pendingTransfers:
    key => `${userId}*${guildId}*${idx}`
    value => { userId, guildId, idx, price, expiresAt, valid, messageId? }
*/
let pendingTransfers = {};
let giveawaysRunning = {}; // gid -> boolean
let giveawayUpdateIntervals = {}; // gid -> interval id

// PROBOT message monitor: validate pending transfers
client.on('messageCreate', msg => {
  try{
    if (msg.author?.id !== PROBOT_ID) return;
    const text = msg.content || '';
    if (!text) return;
    if (!(text.includes("قام بتحويل") || text.includes("تحويل") || text.includes("تحولت") || text.includes("تحويلًا"))) return;
    const amountMatch = text.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (!amountMatch) return;
    const amount = parseFloat(amountMatch[1]);
    const mentionMatches = [...text.matchAll(/<@!?(\\d+)>/g)];
    const mentions = mentionMatches.map(m=>m[1]);
    // check each pending transfer
    for (const key in pendingTransfers){
      const p = pendingTransfers[key];
      if(!p) continue;
      const data = readData();
      const expectedBank = data.guilds[p.guildId]?.bankUserId || null;
      // if expected bank set -> check mention includes it
      if(expectedBank && mentions.includes(expectedBank) && amount >= p.price && Date.now() < p.expiresAt){
        p.valid = true;
      }
    }
  }catch(e){ console.error('PROBOT monitor error', e); }
});

// helper: update giveaway message fields (preserve winners field)
async function updateGiveawayMessage(gid){
  try{
    const data = readData();
    const gav = data.giveaways?.[gid];
    if(!gav) return;
    const channel = await client.channels.fetch(gav.channelId).catch(()=>null);
    if(!channel) return;
    const msg = await channel.messages.fetch(gav.messageId).catch(()=>null);
    if(!msg) return;
    const embed = msg.embeds[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
    // ensure fields: 'الجائزة','عدد الفائزين','المشاركون','ينتهي بعد'
    const fields = embed.fields ? [...embed.fields] : [];
    // update participants field
    const idxPar = fields.findIndex(f=>f.name === 'المشاركون');
    if(idxPar !== -1) fields[idxPar].value = `${gav.participants?.length || 0}`;
    else fields.push({ name:'المشاركون', value:`${gav.participants?.length || 0}`, inline:true });
    // ensure winners field present
    const idxWin = fields.findIndex(f=>f.name === 'عدد الفائزين');
    if(idxWin === -1) fields.splice(1,0,{ name:'عدد الفائزين', value:`${gav.winners || 1}`, inline:true });
    // update ends field
    const remainingMs = gav.endsAt - Date.now();
    const remText = remainingMs > 0 ? formatDuration(remainingMs) : '0s';
    const idxEnds = fields.findIndex(f=>f.name === 'ينتهي بعد');
    if(idxEnds !== -1) fields[idxEnds].value = `${remText}`;
    else fields.push({ name:'ينتهي بعد', value:`${remText}`, inline:true });
    embed.setFields(fields);
    await msg.edit({ embeds:[embed], components: msg.components }).catch(()=>null);
  }catch(e){ console.error('updateGiveawayMessage:', e); }
}

// Run a giveaway timeout + periodic updates
function runGiveawayTimeout(gid, duration){
  if(giveawaysRunning[gid]) return;
  giveawaysRunning[gid] = true;
  // periodic update each 60s (also do one immediately)
  updateGiveawayMessage(gid);
  giveawayUpdateIntervals[gid] = setInterval(()=> updateGiveawayMessage(gid), 60*1000);

  setTimeout(async ()=>{
    try{
      // clear interval
      if(giveawayUpdateIntervals[gid]) clearInterval(giveawayUpdateIntervals[gid]);
      delete giveawayUpdateIntervals[gid];

      const d = readData();
      const gav = d.giveaways?.[gid];
      if(!gav){ delete giveawaysRunning[gid]; return; }
      const participants = gav.participants || [];
      const winnersCount = gav.winners || 1;
      const channel = await client.channels.fetch(gav.channelId).catch(()=>null);
      if(!channel){ delete d.giveaways[gid]; writeData(d); delete giveawaysRunning[gid]; return; }
      if(participants.length === 0){
        await channel.send({ content: `انتهى الجيف واي ولم يسجل أحد.` }).catch(()=>null);
        delete d.giveaways[gid]; writeData(d); delete giveawaysRunning[gid]; return;
      }
      const winners = [];
      const pool = [...new Set(participants)];
      while(winners.length < Math.min(winnersCount, pool.length)){
        const idx = Math.floor(Math.random()*pool.length);
        winners.push(pool.splice(idx,1)[0]);
      }

      // create ticket rooms for winners inside winCategory and send welcome (mention role if set)
      const guildId = gav.guildId;
      const dGuild = d.guilds[guildId] || {};
      const winCategoryId = dGuild.winCategory || null;
      const guild = await client.guilds.fetch(guildId).catch(()=>null);
      const roomMentions = [];
      if(guild && winCategoryId){
        const cat = guild.channels.cache.get(winCategoryId) || await guild.channels.fetch(winCategoryId).catch(()=>null);
        for(const winId of winners){
          try{
            const roomName = `فاز-${gav.prize}`.replace(/\s+/g,'-').slice(0,90);
            const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
            if(cat && cat.permissionOverwrites && cat.permissionOverwrites.cache){
              for(const po of cat.permissionOverwrites.cache.values()){
                if(po.type === 'role' || po.type === OverwriteType.Role){
                  const allow = (po.allow && (po.allow & PermissionsBitField.Flags.ViewChannel)) || false;
                  if(allow) overwrites.push({ id: po.id, allow: [PermissionsBitField.Flags.ViewChannel] });
                }
              }
            }
            overwrites.push({ id: winId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
            const created = await guild.channels.create({
              name: roomName,
              type: ChannelType.GuildText,
              parent: winCategoryId,
              topic: `غرفة لاستلام جائزة ${gav.prize} — الفائز: <@${winId}>`,
              permissionOverwrites: overwrites
            }).catch(()=>null);
            if(created){
              roomMentions.push(`<#${created.id}>`);
              // send welcome message ONLY in the ticket channel
              const mentionRoleId = d.guilds[guildId]?.mentionRoleId || null;
              let welcome = `👋 مرحباً بكم!\nارجو الانتظار حتي قدوم الأونر للتسليم\n`;
              if(mentionRoleId){
                welcome = `${welcome}<@&${mentionRoleId}>`;
              }
              await created.send({ content: welcome }).catch(()=>null);
              // DM winner with link to ticket
              try{
                const u = await client.users.fetch(winId).catch(()=>null);
                if(u){
                  const url = `https://discord.com/channels/${guildId}/${created.id}`;
                  await u.send(`🎉 مبروك! فزت في الجيف واي: ${gav.prize}\nتوجه الى التذكرة: ${url}`).catch(()=>null);
                }
              }catch(e){}
            }
          }catch(e){ console.error(e); }
        }
      }

      const mentionWinners = winners.map(id=>`<@${id}>`).join(' ، ');
      const roomsText = roomMentions.length ? `\n\nتوجهوا للرومات التالية لاستلام جائزتكم:\n${roomMentions.join('\n')}` : '';
      await channel.send({ content: `🎉 الفائزين: ${mentionWinners}\nالجائزة: ${gav.prize}${roomsText}` }).catch(()=>null);

      // fallback DM winners
      for(const winId of winners){
        try{
          const u = await client.users.fetch(winId).catch(()=>null);
          if(u) u.send(`🎉 مبروك! فزت في الجيف واي: ${gav.prize}`).catch(()=>null);
        }catch(e){}
      }

      // schedule delete of giveaway channel if requested
      if(gav.deleteAfterMs && gav.deleteAfterMs > 0){
        setTimeout(async ()=>{
          try{
            const ch = await client.channels.fetch(gav.channelId).catch(()=>null);
            if(ch) await ch.delete().catch(()=>null);
          }catch(e){}
        }, gav.deleteAfterMs);
      }

      // cleanup
      delete d.giveaways[gid];
      writeData(d);
      delete giveawaysRunning[gid];
    }catch(e){ console.error(e); delete giveawaysRunning[gid]; }
  }, duration);
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const guildId = interaction.guildId;
      const data = readData();
      if (!data.guilds[guildId]) data.guilds[guildId] = { ads: [], reviewChannel: null, postedMessageId: null, points:{}, giveawaySettings: {}, winCategory: null, bankUserId: null, mentionRoleId: null };
      // room_adds
      if (interaction.commandName === 'room_adds') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        const channel = interaction.options.getChannel('channel', true);
        data.guilds[guildId].reviewChannel = channel.id;
        writeData(data);
        return interaction.reply({ content: `✅ تم حفظ روم المراجعة`, ephemeral: true });
      }
      // new_adds
      if (interaction.commandName === 'new_adds') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        const raw = interaction.options.getString('ads', true);
      // normalize (digits, whitespace, possible accidental 'ads:' prefix)
      function normalizeAdsInput(raw){
        if(!raw) return '';
        let s = String(raw).trim();
        s = s.replace(/\u00A0/g, ' ').replace(/\u200B/g, '').replace(/\uFEFF/g, '');
        s = s.replace(/[٠-٩]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48));
        s = s.replace(/[۰-۹]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x06F0 + 48));
        s = s.replace(/\s+/g, ' ').trim();
        const firstToken = s.split(/\s+/,1)[0] || '';
        const colonCount = (firstToken.match(/:/g) || []).length;
        if(/^\s*ads\s*(?:[:=：])\s*/i.test(s) && colonCount >= 2){
          s = s.replace(/^\s*ads\s*(?:[:=：])\s*/i, '');
        }
        return s;
      }
      const cleaned = normalizeAdsInput(raw);
      console.log('[DEBUG] raw input:', raw);
      console.log('[DEBUG] cleaned input:', cleaned);
      const parts = cleaned.split(/\s+/).filter(Boolean);
      console.log('[DEBUG] parts:', parts);
      const matches = [];
      for(const p of parts){
        const m = p.match(/^([^:]+):(\d+)$/);
        console.log('[DEBUG] test', p, '->', !!m, m && m.slice(1));
        if(m) matches.push({ name: m[1].trim(), price: parseInt(m[2],10) });
      }
        data.guilds[guildId].ads = matches;
        writeData(data);
        // post a selector message in current channel
        const embed = new EmbedBuilder().setTitle('اختر إعلانك').setTimestamp();
        const options = matches.slice(0, 25).map((a, i) => ({ label: a.name, description: `السعر: ${a.price}`, value: `${i}` }));
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`select_add_${guildId}`).setPlaceholder('اختر...').addOptions(options));
        const sent = await interaction.channel.send({ embeds: [embed], components: [row] });
        data.guilds[guildId].postedMessageId = sent.id;
        writeData(data);
        return interaction.reply({ content: '✅ تم نشر الإعلانات', ephemeral: true });
      }
      // list_adds
      if (interaction.commandName === 'list_adds') {
        const ads = data.guilds[guildId]?.ads || [];
        if (ads.length === 0) return interaction.reply({ content: 'لا يوجد إعلانات', ephemeral: true });
        const lines = ads.map(a => `• **${a.name}** — ${a.price}`);
        return interaction.reply({ content: lines.join('\\n'), ephemeral: true });
      }
      // cat_giv
      if (interaction.commandName === 'cat_giv') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        const adName = interaction.options.getString('ad_name', true);
        const category = interaction.options.getChannel('category', true);
        if(category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '⚠️ اختر كاتيجوري صحيح', ephemeral: true });
        const prize = interaction.options.getString('prize', true);
        const durationStr = interaction.options.getString('duration', true);
        const winners = interaction.options.getInteger('winners', true);
        const deleteAfterStr = interaction.options.getString('delete_after', false) || null;
        const mentionType = (interaction.options.getString('mention', false) || 'none').toLowerCase();
        const durationMs = parseDuration(durationStr);
        const deleteAfterMs = deleteAfterStr ? parseDuration(deleteAfterStr) : null;
        if(durationMs === null) return interaction.reply({ content: '⚠️ صيغة مدة خاطئة. مثال: 1m 2h 3d', ephemeral: true });
        data.guilds[guildId].giveawaySettings[adName] = { categoryId: category.id, prize, durationMs, winners, deleteAfterMs, mentionType };
        writeData(data);
        return interaction.reply({ content: `✅ تم ضبط الجيف واي للإعلان ${adName}`, ephemeral: true });
      }
      // delete_room_adds
      if (interaction.commandName === 'delete_room_adds') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        const reviewChannelId = data.guilds[guildId]?.reviewChannel;
        if(!reviewChannelId) return interaction.reply({ content: '⚠️ لا يوجد روم مراجعة مضبوط', ephemeral: true });
        delete data.guilds[guildId].reviewChannel;
        writeData(data);
        return interaction.reply({ content: '✅ تم حذف روم المراجعة من الإعدادات', ephemeral: true });
      }
      // room_win_giv
      if (interaction.commandName === 'room_win_giv') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        const category = interaction.options.getChannel('category', true);
        if(category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '⚠️ اختر كاتيجوري صحيح', ephemeral: true });
        data.guilds[guildId].winCategory = category.id;
        writeData(data);
        return interaction.reply({ content: '✅ تم ضبط كاتيجوري غرف الفائزين', ephemeral: true });
      }
      // close
      if (interaction.commandName === 'close') {
        const data2 = readData();
        const winCat = data2.guilds[guildId]?.winCategory;
        if(!winCat) return interaction.reply({ content: '⚠️ لا يوجد كاتيجوري للفائزين مضبوط', ephemeral: true });
        const ch = interaction.channel;
        if(!ch || ch.parentId !== winCat) return interaction.reply({ content: '⚠️ هذا ليس روم فوز (تكت).', ephemeral: true });
        if(!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        try{ await ch.delete().catch(()=>null); }catch(e){}
        return;
      }
      // set_bank
      if (interaction.commandName === 'set_bank') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        data.guilds[guildId].bankUserId = user.id;
        writeData(data);
        return interaction.reply({ content: `✅ تم ضبط البنك ليكون: <@${user.id}>`, ephemeral: true });
      }
      // choose_role_m
      if (interaction.commandName === 'choose_role_m') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        const role = interaction.options.getRole('role', true);
        data.guilds[guildId].mentionRoleId = role.id;
        writeData(data);
        return interaction.reply({ content: `✅ تم ضبط رتبة المنشن: <@&${role.id}>`, ephemeral: true });
      }
      // delete_role_m
      if (interaction.commandName === 'delete_role_m') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ صلاحيات', ephemeral: true });
        delete data.guilds[guildId].mentionRoleId;
        writeData(data);
        return interaction.reply({ content: `✅ تم حذف رتبة المنشن`, ephemeral: true });
      }
    } // end chat input

    // select menu (choose ad)
    if (interaction.isStringSelectMenu()) {
      if (!interaction.customId.startsWith('select_add_')) return;
      const guildId = interaction.guildId;
      const data = readData();
      const ads = data.guilds[guildId]?.ads || [];
      const idx = parseInt(interaction.values[0], 10);
      const ad = ads[idx];
      if (!ad) return interaction.reply({ content: 'خطأ', ephemeral: true });
      const key = interaction.user.id+"*"+guildId+"*"+idx;
      pendingTransfers[key] = { price:ad.price, expiresAt:Date.now()+120000, valid:false, userId: interaction.user.id, guildId, idx, messageId: null };
      const embed = new EmbedBuilder().setTitle(`${ad.name}`).setDescription(`السعر: ${ad.price}`).setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`paid_${guildId}_${idx}`).setLabel('لقد حولت').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`points_${guildId}_${idx}`).setLabel('نقاطي').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`request_${guildId}_${idx}`).setLabel('طلب إعلان').setStyle(ButtonStyle.Primary)
      );
      // send ephemeral reply with embed and buttons
      return interaction.reply({ embeds:[embed], components:[row], ephemeral:true });
    }

    // buttons
    if(interaction.isButton()){
      if(interaction.customId.startsWith('paid_') || interaction.customId.startsWith('points_') || interaction.customId.startsWith('request_')){
        const [action,guildId,idx] = interaction.customId.split('_');
        const data = readData();
        if(!data.guilds[guildId]) return interaction.reply({ content:'خطأ', ephemeral:true });
        const ad = data.guilds[guildId].ads[parseInt(idx)];
        if(!ad) return interaction.reply({ content:'خطأ', ephemeral:true });

        if(action==="paid"){
          await interaction.deferUpdate().catch(()=>null);
          const key = interaction.user.id+"*"+guildId+"*"+idx;
          const freeMode = data.freeUsers?.[OWNER_FREE_TARGET] === true && OWNER_FREE_TARGET === interaction.user.id;
          const kingModeEnabled = data.kingsEnabled?.[guildId] === true;
          const hasKingsRole = interaction.member.roles ? interaction.member.roles.cache.has(KINGS_ROLE_ID) : false;
          const kingApplies = kingModeEnabled && hasKingsRole;
          if(freeMode || kingApplies || (pendingTransfers[key] && pendingTransfers[key].valid)){
            if(!data.guilds[guildId].points[interaction.user.id]) data.guilds[guildId].points[interaction.user.id]={};
            data.guilds[guildId].points[interaction.user.id][ad.name]=(data.guilds[guildId].points[interaction.user.id][ad.name]||0)+1;
            writeData(data);
            delete pendingTransfers[key];
            return interaction.followUp({ content:"✅ تمت إضافة نقطة", ephemeral:true });
          } else {
            return interaction.followUp({ content:"❌ لا يوجد تحويل", ephemeral:true });
          }
        }

        if(action==="points"){
          await interaction.deferUpdate().catch(()=>null);
          const pts = data.guilds[guildId].points?.[interaction.user.id]?.[ad.name]||0;
          return interaction.followUp({ content:`رصيدك من ${ad.name}: ${pts}`, ephemeral:true });
        }

        if(action==="request"){
          const pts = data.guilds[guildId].points?.[interaction.user.id]?.[ad.name]||0;
          if(pts<=0) return interaction.reply({ content:"❌ لا تملك نقاط", ephemeral:true });
          data.guilds[guildId].points[interaction.user.id][ad.name]=pts-1;
          writeData(data);

          const modal = new ModalBuilder()
            .setCustomId(`submit_ad_${guildId}_${idx}_${interaction.user.id}_${Date.now()}`)
            .setTitle(`طلب — ${ad.name}`);
          const inputDesc = new TextInputBuilder().setCustomId('desc').setLabel('الوصف').setStyle(TextInputStyle.Paragraph).setRequired(true);
          const inputInfo = new TextInputBuilder().setCustomId('info').setLabel('معلومات إضافية').setStyle(TextInputStyle.Short).setRequired(false);
          modal.addComponents(new ActionRowBuilder().addComponents(inputDesc), new ActionRowBuilder().addComponents(inputInfo));

          await interaction.showModal(modal);
          return;
        }
      }

      // approve / reject (review post)
      if(interaction.customId.startsWith('approve_') || interaction.customId.startsWith('reject_')){
        await interaction.deferUpdate().catch(()=>null);
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return interaction.followUp({ content:'❌ صلاحيات', ephemeral:true });
        const parts = interaction.customId.split('_');
        const action = parts[0];
        const requestUserId = parts[2];
        if(action==='approve'){
          try{ const user = await client.users.fetch(requestUserId); await user.send("✅ تمت الموافقة").catch(()=>null); }catch(e){}
          const originalEmbed = interaction.message.embeds[0] || new EmbedBuilder();
          const newEmbed = EmbedBuilder.from(originalEmbed).setColor(0x00FF00).setTimestamp();
          try{
            const data = readData();
            const guildId = interaction.guildId;
            let adName = (originalEmbed.title || '').replace(/^طلب —\s*/i, '') || null;
            if(!adName){
              adName = Object.keys(data.guilds[guildId].giveawaySettings || {})[0] || null;
            }
            const desc = originalEmbed.description || (originalEmbed.fields?.find(f=>f.name==='معلومات إضافية')?.value) || '';
            const giveawaySetting = data.guilds[guildId].giveawaySettings?.[adName] || null;
            const prize = giveawaySetting?.prize || '';
            const categoryId = giveawaySetting?.categoryId || null;
            const giveawayDuration = giveawaySetting?.durationMs || null;
            const winnersCount = giveawaySetting?.winners || 1;
            const deleteAfterMs = giveawaySetting?.deleteAfterMs || null;
            const mentionType = (giveawaySetting?.mentionType || 'none');
            if(categoryId && giveawayDuration){
              const guild = await client.guilds.fetch(guildId);
              const cat = guild.channels.cache.get(categoryId) || await guild.channels.fetch(categoryId).catch(()=>null);
              if(cat && cat.type === ChannelType.GuildCategory){
                const sanitized = String(prize).replace(/\s+/g,'-').slice(0,90);
                const channelName = (`${sanitized}`).toLowerCase().slice(0,90);
                const overwrites = [];
                overwrites.push({ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] });
                if(cat.permissionOverwrites && cat.permissionOverwrites.cache){
                  for(const po of cat.permissionOverwrites.cache.values()){
                    if(po.type === OverwriteType.Role){
                      const allow = po.allow?.has?.(PermissionsBitField.Flags.ViewChannel) || (po.allow && (po.allow & PermissionsBitField.Flags.ViewChannel));
                      if(allow){
                        overwrites.push({ id: po.id, allow: [PermissionsBitField.Flags.ViewChannel] });
                      }
                    }
                  }
                }
                const createdChannel = await guild.channels.create({
                  name: channelName,
                  type: ChannelType.GuildText,
                  parent: categoryId,
                  topic: desc || `Giveaway for ${adName || 'item'}`,
                  permissionOverwrites: overwrites
                }).catch(()=>null);
                if(createdChannel){
                  // SEND description as PLAIN TEXT ABOVE the embed
                  if(desc || mentionType !== 'none'){
                    let content = desc || '';
                    if(mentionType === 'everyone') content += (content? '\n' : '') + '@everyone';
                    else if(mentionType === 'here') content += (content? '\n' : '') + '@here';
                    if(content.trim().length > 0){
                      await createdChannel.send({ content }).catch(()=>null);
                    }
                  }
                  // now send the giveaway embed
                  const gEmbed = new EmbedBuilder()
                    .setTitle(`${prize}`)
                    .addFields(
                      { name: 'الجائزة', value: `${prize}`, inline:true },
                      { name: 'عدد الفائزين', value: `${winnersCount}`, inline:true },
                      { name: 'المشاركون', value: `0`, inline:true },
                      { name: 'ينتهي بعد', value: `${formatDuration(giveawayDuration)}`, inline:true }
                    )
                    .setTimestamp();
                  const joinBtn = new ButtonBuilder().setCustomId(`join_giv_${guildId}_${createdChannel.id}`).setLabel('🎉 اشترك').setStyle(ButtonStyle.Primary);
                  const gRow = new ActionRowBuilder().addComponents(joinBtn);
                  const sent = await createdChannel.send({ embeds:[gEmbed], components:[gRow] }).catch(()=>null);
                  if(sent){
                    const gid = sent.id;
                    if(!data.giveaways) data.giveaways = {};
                    data.giveaways[gid] = { guildId, channelId: createdChannel.id, messageId: sent.id, prize, endsAt: Date.now() + giveawayDuration, winners: winnersCount, participants: [], deleteAfterMs, mentionType, adName };
                    writeData(data);
                    // send the single-letter message 'ق' in the giveaway channel (only there)
                    await createdChannel.send({ content: 'ق' }).catch(()=>null);
                    runGiveawayTimeout(gid, giveawayDuration);
                  }
                }
              }
            }
          }catch(e){ console.error(e); }
          return interaction.message.edit({ embeds:[newEmbed], components:[] }).catch(()=>null);
        } else {
          try{ const user = await client.users.fetch(requestUserId); await user.send("❌ تم الرفض").catch(()=>null); }catch(e){}
          const originalEmbed = interaction.message.embeds[0] || new EmbedBuilder();
          const newEmbed = EmbedBuilder.from(originalEmbed).setColor(0xFF0000).setTimestamp();
          return interaction.message.edit({ embeds:[newEmbed], components:[] }).catch(()=>null);
        }
      }

      // join_giv handler
      if(interaction.customId.startsWith('join_giv_')){
        await interaction.deferUpdate().catch(()=>null);
        const d = readData();
        const gav = d.giveaways[interaction.message.id];
        if(!gav) return interaction.followUp({ content:'⚠️ هذا الجيف واي انتهى أو غير موجود', ephemeral:true });
        if(Date.now() > gav.endsAt) return interaction.followUp({ content:'⚠️ هذا الجيف واي انتهى', ephemeral:true });
        if(!gav.participants.includes(interaction.user.id)){
          gav.participants.push(interaction.user.id);
          writeData(d);
          // update embed participants count in the giveaway message (preserve winners field)
          try{
            const msg = await interaction.message.fetch();
            const embed = msg.embeds[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
            const fields = embed.fields || [];
            const idx = fields.findIndex(f=>f.name === 'المشاركون');
            if(idx !== -1){
              fields[idx].value = `${gav.participants.length}`;
            } else {
              fields.push({ name: 'المشاركون', value: `${gav.participants.length}`, inline:true });
            }
            // ensure winners field present
            if(!fields.find(f=>f.name==='عدد الفائزين')){
              fields.splice(1,0,{ name:'عدد الفائزين', value:`${gav.winners || 1}`, inline:true });
            }
            embed.setFields(fields);
            await msg.edit({ embeds:[embed], components: msg.components }).catch(()=>null);
          }catch(e){ console.error(e); }
          return interaction.followUp({ content:'✅ تم اشتراكك في الجيف واي', ephemeral:true });
        } else {
          return interaction.followUp({ content:'⚠️ أنت بالفعل مشترك', ephemeral:true });
        }
      }
    } // end buttons & select

    // modal submit - request ad
    if (interaction.isModalSubmit() && interaction.customId.startsWith('submit_ad_')){
      const parts = interaction.customId.split('_');
      const guildId = parts[2];
      const idx = parseInt(parts[3],10);
      const requestUserId = parts[4];
      const data = readData();
      const ad = data.guilds[guildId]?.ads?.[idx];
      if(!ad) return interaction.reply({ content: 'خطأ', ephemeral: true });
      const desc = interaction.fields.getTextInputValue('desc');
      const info = interaction.fields.getTextInputValue('info')||'لا شيء';
      const reviewEmbed = new EmbedBuilder()
        .setTitle(`طلب — ${ad.name}`)
        .setDescription(desc)
        .addFields(
          { name:'السعر', value:`${ad.price}`, inline:true },
          { name:'مقدّم الطلب', value:`<@${requestUserId}>`, inline:true },
          { name:'معلومات إضافية', value:info }
        )
        .setTimestamp();
      const approveBtn = new ButtonBuilder().setCustomId(`approve_${guildId}_${requestUserId}_${Date.now()}`).setLabel('موافق ✅').setStyle(ButtonStyle.Success);
      const rejectBtn = new ButtonBuilder().setCustomId(`reject_${guildId}_${requestUserId}_${Date.now()}`).setLabel('رفض ❌').setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(approveBtn,rejectBtn);
      const reviewChannelId = data.guilds[guildId]?.reviewChannel;
      if(!reviewChannelId) return interaction.reply({ content:'⚠️ لا يوجد روم مراجعة', ephemeral:true });
      const reviewChannel = await client.channels.fetch(reviewChannelId).catch(()=>null);
      if(!reviewChannel) return interaction.reply({ content:'⚠️ خطأ في الروم', ephemeral: true });
      await reviewChannel.send({ embeds:[reviewEmbed], components:[row] });
      return interaction.reply({ content:'✅ تم الإرسال للمراجعة', ephemeral:true });
    }
  } catch (err) { console.error(err); }
}); // end interactionCreate

// message commands: free/kings toggles + convenience
client.on('messageCreate', async msg=>{
  try{
    if(msg.author.bot) return;
    const data = readData();
    // !free (toggle ON for OWNER_FREE_TARGET) - only owner or bot owner id can toggle (for safety use guild owner or admin)
    if(msg.content === '!free'){
      if(msg.author.id !== OWNER_FREE_TARGET && !msg.member?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild)){
        return msg.reply('❌ لا تملك صلاحية تفعيل هذا الأمر');
      }
      data.freeUsers = data.freeUsers || {};
      data.freeUsers[OWNER_FREE_TARGET] = true;
      writeData(data);
      return msg.reply('✅ تم تفعيل وضع الفري للمستخدم المحدد');
    }
    if(msg.content === '!offfree'){
      if(msg.author.id !== OWNER_FREE_TARGET && !msg.member?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild)){
        return msg.reply('❌ لا تملك صلاحية');
      }
      data.freeUsers = data.freeUsers || {};
      delete data.freeUsers[OWNER_FREE_TARGET];
      writeData(data);
      return msg.reply('✅ تم إلغاء وضع الفري للمستخدم المحدد');
    }
    // !kings - toggle kings mode for this guild (requires user has the kings role)
    if(msg.content === '!kings'){
      const guildId = msg.guildId;
      if(!msg.member) return msg.reply('❌ هذا الأمر داخل سيرفر فقط');
      if(!msg.member.roles.cache.has(KINGS_ROLE_ID)) return msg.reply('❌ يجب أن تمتلك رتبة الكينج لتفعيل هذا الأمر');
      data.kingsEnabled = data.kingsEnabled || {};
      data.kingsEnabled[guildId] = true;
      writeData(data);
      return msg.reply('✅ تم تفعيل وضع الكينج لهذا السيرفر');
    }
    if(msg.content === '!unkings'){
      const guildId = msg.guildId;
      if(!msg.member) return msg.reply('❌ هذا الأمر داخل سيرفر فقط');
      if(!msg.member.roles.cache.has(KINGS_ROLE_ID)) return msg.reply('❌ يجب أن تمتلك رتبة الكينج لإيقاف هذا الأمر');
      data.kingsEnabled = data.kingsEnabled || {};
      delete data.kingsEnabled[guildId];
      writeData(data);
      return msg.reply('✅ تم إيقاف وضع الكينج لهذا السيرفر');
    }
  }catch(e){ console.error('message command err', e); }
});

// login
client.login(TOKEN);

