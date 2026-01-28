const { TranslateClient, TranslateTextCommand } = require('@aws-sdk/client-translate');
const config = require('../config');

const translateClient = new TranslateClient(config.AWS);

async function translateText(text, sourceLanguage, targetLanguage) {
  if (sourceLanguage === targetLanguage || !text || text.trim() === '') {
    return text;
  }

  try {
    const command = new TranslateTextCommand({
      Text: text,
      SourceLanguageCode: sourceLanguage,
      TargetLanguageCode: targetLanguage,
    });

    const response = await translateClient.send(command);
    return response.TranslatedText || text;
  } catch (error) {
    console.error('[Translation] Error:', error.message);
    return text;
  }
}

module.exports = { translateText };
