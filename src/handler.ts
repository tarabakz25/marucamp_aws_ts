import { Client, middleware, WebhookEvent, FlexMessage, TextMessage, validateSignature } from "@line/bot-sdk";
import { APIGatewayProxyResult } from "aws-lambda";
import { OpenAI } from "openai";
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import * as flexCamp from "./flex/camp.json"
import * as flexYaychi from "./flex/yaychi.json"

const client = new Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.CHANNEL_SECRET!,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const ddb = new DynamoDBClient({});

interface CampInfo {
  name: string;
  homepage_url?: string;
}

interface YaychiInfo {
  name: string;
  spot: string;
  description: string;
}

interface ItemInfo {
  name: string;
  description: string;
}

/* Handler */
export const handler = async (event: any): Promise<APIGatewayProxyResult> => {
  // 1. そもそも body が無ければ 200
  if (!event.body) {
    return { statusCode: 200, body: 'no body' };
  }

  // 2. 署名検証
  const signature = event.headers['x-line-signature'] ?? event.headers['X-Line-Signature'];
  if (!signature || !validateSignature(event.body, process.env.CHANNEL_SECRET!, signature)) {
    return { statusCode: 401, body: 'signature validation failed' };
  }

  // 3. JSON パース & events 取得
  const { events = [] } = JSON.parse(event.body) as { events?: WebhookEvent[] };
  if (events.length === 0) {
    return { statusCode: 200, body: 'no events' };
  }

  const [e] = events;

  // 4. ここから本来のロジック
  if (e.type === 'follow') {
    await saveUserId(e.source.userId!);
    await reply(e.replyToken, {
      type: 'text',
      text: '友達追加ありがとうございます🚀',
    });
    return { statusCode: 200, body: 'OK' };
  }

  if (e.type === 'message' && e.message.type === 'text') {
    const uid = e.source.userId;
    const text = e.message.text;
    await saveUserId(uid!);

    const state = await getState(uid!);

    // ユーザーの状態に応じた処理
    if (!state) {
      // 初期状態：メニュー選択
      if (text === 'きゃんぷ場調べ') {
        await putState(uid!, 'awaiting_region_camp');
        await reply(e.replyToken, {
          type: 'text',
          text: '調べたい地域を教えてください。',
        });
        return { statusCode: 200, body: 'OK' };
      }
      else if (text === '野営地調べ') {
        await putState(uid!, 'awaiting_prefecture_yaychi');
        await reply(e.replyToken, {
          type: 'text',
          text: '野営したい都道府県を教えてください。',
        });
        return { statusCode: 200, body: 'OK' };
      }
      else if (text === '持ち物提案') {
        await putState(uid!, 'awaiting_location_items');
        await reply(e.replyToken, {
          type: 'text',
          text: '行く場所を教えてください。',
        });
        return { statusCode: 200, body: 'OK' };
      }
      else {
        await handleGeneralMessage(e.replyToken, text);
        return { statusCode: 200, body: 'OK' };
      }
    }
    else {
      // 状態に応じた処理
      await handleStateMessage(uid!, e.replyToken, text, state);
      return { statusCode: 200, body: 'OK' };
    }
  }

  return { statusCode: 200, body: 'ignored' };
};

async function handleStateMessage(uid: string, replyToken: string, text: string, state: string): Promise<void> {
  switch (state) {
    // キャンプ場調べフロー
    case 'awaiting_region_camp':
      await putStateWithData(uid, 'awaiting_date_camp', { region: text });
      await reply(replyToken, {
        type: 'text',
        text: '行きたい日にちを教えてください。',
      });
      break;

    case 'awaiting_date_camp':
      const campRegion = await getStateData(uid, 'region');
      await putStateWithData(uid, 'awaiting_conditions_camp', { region: campRegion, date: text });
      await reply(replyToken, {
        type: 'text',
        text: '希望する条件はありますか？（例：ペットOK、温泉あり、など）',
      });
      break;

    case 'awaiting_conditions_camp':
      const campData = await getStateData(uid);
      await clearState(uid);
      await handleCampInfo(uid, replyToken, campData.region, campData.date, text);
      break;

    // 野営地調べフロー
    case 'awaiting_prefecture_yaychi':
      await putStateWithData(uid, 'awaiting_conditions_yaychi', { prefecture: text });
      await reply(replyToken, {
        type: 'text',
        text: '希望する条件はありますか？（例：川の近く、山の中、など）',
      });
      break;

    case 'awaiting_conditions_yaychi':
      const yaychiData = await getStateData(uid);
      await clearState(uid);
      await handleYaychiInfo(uid, replyToken, yaychiData.prefecture, text);
      break;

    // 持ち物提案フロー
    case 'awaiting_location_items':
      await putStateWithData(uid, 'awaiting_duration_items', { location: text });
      await reply(replyToken, {
        type: 'text',
        text: '滞在期間を教えてください。',
      });
      break;

    case 'awaiting_duration_items':
      const itemLocation = await getStateData(uid, 'location');
      await putStateWithData(uid, 'awaiting_conditions_items', { location: itemLocation, duration: text });
      await reply(replyToken, {
        type: 'text',
        text: 'その他の特別な条件があれば教えてください。（例：雨の可能性がある、子供連れ、など）',
      });
      break;

    case 'awaiting_conditions_items':
      const itemData = await getStateData(uid);
      await clearState(uid);
      await handleItemSuggestion(uid, replyToken, itemData.location, itemData.duration, text);
      break;

    default:
      await clearState(uid);
      await handleGeneralMessage(replyToken, text);
      break;
  }
}

async function handleCampInfo(uid: string, replyToken: string, region: string, date: string, conditions: string): Promise<void> {
  // 最初に即座に返信
  await reply(replyToken, {
    type: 'text',
    text: `${region}の${date}に行きたいキャンプ場を、条件「${conditions}」で調べています...`,
  });

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `${region}の${date}で、条件「${conditions}」を満たすキャンプ場を3つ検索し、名前のみリストで出力してください。`
        }
      ]
    });

    const campInfo = parseResponse(res);
    
    if (campInfo.length === 0) {
      await pushMessage(uid, '申し訳ありません。キャンプ場の情報を取得できませんでした。');
      return;
    }

    // FlexMessageを作成
    const flexMessage = createCampFlexMessage(campInfo);
    
    // メッセージ送信
    await pushMessage(uid, '以下のキャンプ場を見つけました！');
    await pushFlexMessage(uid, flexMessage);

    // 詳細情報を取得
    const detailRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `${campInfo.map(camp => camp.name).join('、')}について、それぞれ以下の項目を書いてください：
1.キャンプ場名
2.市区町村
3.キャンプ場設備
この形式以外は書かないでください。`
        }
      ]
    });

    await pushMessage(uid, detailRes.choices[0].message.content || '詳細情報を取得できませんでした。');

  } catch (error) {
    console.error('Error in handleCampInfo:', error);
    await pushMessage(uid, 'キャンプ場の情報取得中にエラーが発生しました。');
  }
}

async function handleYaychiInfo(uid: string, replyToken: string, prefecture: string, conditions: string): Promise<void> {
  await reply(replyToken, {
    type: 'text',
    text: `${prefecture}で、条件「${conditions}」に合う野営ができる場所を調べています...`,
  });

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `${prefecture}で野営ができる市区町村を3つ調べて、条件「${conditions}」に合うものを選んでください。それぞれの市区町村について以下の情報を教えてください：
1. 市区町村名
2. おすすめの野営スポット
3. そのスポットの特徴や注意点
回答は以下のフォーマットで提供してください：
1. [市区町村名]
おすすめスポット: [スポット名]
特徴・注意点: [簡単な説明]`
        }
      ]
    });

    const yaychiInfo = parseYaychiResponse(res.choices[0].message.content || '');
    
    if (yaychiInfo.length === 0) {
      await pushMessage(uid, '申し訳ありません。野営地の情報を取得できませんでした。');
      return;
    }

    const flexMessage = createYaychiFlexMessage(yaychiInfo);
    
    await pushMessage(uid, `${prefecture}で野営可能な場所が見つかりました！`);
    await pushFlexMessage(uid, flexMessage);

  } catch (error) {
    console.error('Error in handleYaychiInfo:', error);
    await pushMessage(uid, '野営地の情報取得中にエラーが発生しました。');
  }
}

async function handleItemSuggestion(uid: string, replyToken: string, location: string, duration: string, conditions: string): Promise<void> {
  await reply(replyToken, {
    type: 'text',
    text: `${location}に${duration}の期間で行く際の持ち物を、条件「${conditions}」で提案します...`,
  });

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `${location}に${duration}の期間で行く際に必要な持ち物を、条件「${conditions}」を考慮して10個程度リストアップしてください。それぞれの持ち物について、20文字程度の簡潔な説明を加えてください。`
        }
      ]
    });

    const items = parseItemResponse(res.choices[0].message.content || '');
    
    if (items.length === 0) {
      await pushMessage(uid, '申し訳ありません。持ち物の情報を取得できませんでした。');
      return;
    }

    const itemList = items.map(item => `- ${item.name}: ${item.description}`).join('\n');
    await pushMessage(uid, `以下の持ち物をおすすめします：\n\n${itemList}`);

    // 上位3つのアイテムのおすすめ商品を検索
    for (const item of items.slice(0, 3)) {
      const searchRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: `「${item.name} おすすめ 人気」で検索し、評価の高いアイテムを1つ見つけて、その商品名と50文字以内の特徴を教えてください。`
          }
        ]
      });

      await pushMessage(uid, `${item.name}のおすすめ商品：\n${searchRes.choices[0].message.content}`);
    }

  } catch (error) {
    console.error('Error in handleItemSuggestion:', error);
    await pushMessage(uid, '持ち物の情報取得中にエラーが発生しました。');
  }
}

async function handleGeneralMessage(replyToken: string, text: string): Promise<void> {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'あなたは「まるキャン」というキャンプの専門家です。キャンプや野営地の質問に答えてください。それ以外の質問には回答しないようにしてください。文末には時々!をつけて、明るいイメージで会話してください。'
        },
        {
          role: 'user',
          content: text
        }
      ],
      max_tokens: 200
    });

    await reply(replyToken, {
      type: 'text',
      text: res.choices[0].message.content || 'すみません、うまく回答できませんでした。',
    });
  } catch (error) {
    console.error('Error in handleGeneralMessage:', error);
    await reply(replyToken, {
      type: 'text',
      text: 'すみません、エラーが発生しました。もう一度お試しください。',
    });
  }
}

function parseResponse(res: any): CampInfo[] {
  const result: CampInfo[] = [];
  const lines = res.choices[0].message.content?.split('\n') || [];
  for (let line of lines) {
    line = line.trim();
    if (line.length > 0 && (line.startsWith('1.') || line.startsWith('2.') || line.startsWith('3.'))) {
      const name = line.replace(/^\d+\.\s*/, '').trim();
      result.push({ name });
    }
  }
  return result;
}

function parseYaychiResponse(responseText: string): YaychiInfo[] {
  const yaychiInfo: YaychiInfo[] = [];
  const lines = responseText.split('\n');
  let currentInfo: Partial<YaychiInfo> = {};
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('1.') || trimmedLine.startsWith('2.') || trimmedLine.startsWith('3.')) {
      if (currentInfo.name) {
        yaychiInfo.push(currentInfo as YaychiInfo);
      }
      currentInfo = { name: trimmedLine.replace(/^\d+\.\s*/, '').trim() };
    } else if (trimmedLine.includes('おすすめスポット:')) {
      currentInfo.spot = trimmedLine.split('おすすめスポット:')[1]?.trim() || '';
    } else if (trimmedLine.includes('特徴・注意点:')) {
      currentInfo.description = trimmedLine.split('特徴・注意点:')[1]?.trim() || '';
    }
  }
  
  if (currentInfo.name) {
    yaychiInfo.push(currentInfo as YaychiInfo);
  }
  
  return yaychiInfo.slice(0, 3);
}

function parseItemResponse(responseText: string): ItemInfo[] {
  const items: ItemInfo[] = [];
  const lines = responseText.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.match(/^\d+\./)) {
      const parts = trimmedLine.split(':', 2);
      if (parts.length === 2) {
        const name = parts[0].replace(/^\d+\.\s*/, '').trim();
        const description = parts[1].trim();
        items.push({ name, description });
      }
    }
  }
  
  return items;
}

function createCampFlexMessage(campInfo: CampInfo[]): FlexMessage {
  const template = JSON.parse(JSON.stringify(flexCamp));
  
  campInfo.forEach((camp, index) => {
    if (index < template.contents.length) {
      const bubble = template.contents[index];
      bubble.body.contents[0].text = camp.name;
      if (camp.homepage_url) {
        bubble.footer.contents[0].contents[0].action.uri = camp.homepage_url;
      }
    }
  });

  return {
    type: 'flex',
    altText: 'キャンプ場情報',
    contents: template
  } as FlexMessage;
}

function createYaychiFlexMessage(yaychiInfo: YaychiInfo[]): FlexMessage {
  const template = JSON.parse(JSON.stringify(flexYaychi));
  
  yaychiInfo.forEach((info, index) => {
    if (index < template.contents.length) {
      const bubble = template.contents[index];
      bubble.body.contents[0].text = info.name;
      bubble.body.contents[1].contents[0].contents[1].text = info.spot;
      bubble.body.contents[1].contents[1].contents[1].text = info.description;
    }
  });

  return {
    type: 'flex',
    altText: '野営地情報',
    contents: template
  } as FlexMessage;
}

async function reply(replyToken: string, message: any) {
  await client.replyMessage(replyToken, message);
}

async function pushMessage(uid: string, text: string) {
  // メッセージを5000文字ごとに分割
  const messages: TextMessage[] = [];
  for (let i = 0; i < text.length; i += 5000) {
    messages.push({
      type: 'text',
      text: text.slice(i, i + 5000)
    } as TextMessage);
  }
  
  for (const message of messages) {
    await client.pushMessage(uid, message);
  }
}

async function pushFlexMessage(uid: string, flexMessage: FlexMessage) {
  await client.pushMessage(uid, flexMessage);
}

async function saveUserId(uid: string) {
  await ddb.send(new PutItemCommand({
    TableName: 'Users',
    Item: {
      userId: { S: uid },
    }
  }));
}

async function getState(uid: string): Promise<string | undefined> {
  const res = await ddb.send(new GetItemCommand({
    TableName: 'Users',
    Key: {
      userId: { S: uid },
    },
  }));

  return res.Item?.state?.S;
}

async function putState(uid: string, state: string) {
  await ddb.send(new PutItemCommand({
    TableName: 'Users',
    Item: {
      userId: { S: uid },
      state: { S: state },
    },
  }));
}

async function putStateWithData(uid: string, state: string, data: any) {
  await ddb.send(new PutItemCommand({
    TableName: 'Users',
    Item: {
      userId: { S: uid },
      state: { S: state },
      data: { S: JSON.stringify(data) },
    },
  }));
}

async function getStateData(uid: string, key?: string): Promise<any> {
  const res = await ddb.send(new GetItemCommand({
    TableName: 'Users',
    Key: {
      userId: { S: uid },
    },
  }));

  const dataString = res.Item?.data?.S;
  if (!dataString) return {};
  
  const data = JSON.parse(dataString);
  return key ? data[key] : data;
}

async function clearState(uid: string) {
  await ddb.send(new PutItemCommand({
    TableName: 'Users',
    Item: {
      userId: { S: uid },
    },
  }));
}