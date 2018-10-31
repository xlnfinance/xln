window.t = function(str) {
  var dict = {
    home: [`Home`, `Главная`],
    wallet: ['Wallet', `Кошелек`],
    banks: ['Banks', `Банки`],
    explorers: [`Explorers`, `Прочее`],

    blockchain_history: [`Blockchain History`, 'Блокчейн'],
    insurances: [`Insurances`, `Страховки`],

    assets: [`Assets`, `Ассеты`],
    onchain_exchange: [`Onchain Exchange`, `Ончейн Обменка`]
  }

  let index = ['en', 'ru'].indexOf(app.lang)

  let result = dict[str]
  if (!result) throw 'Not found translation for ' + str

  return result[index]
}
