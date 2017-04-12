'use strict'

const qs = require('querystring')
const request = require('request')
// require('request-debug')(request)
const moment = require('moment')
const cheerio = require('cheerio')

const {fetcher, filterExisting, saveDataAndFile, models} = require('cozy-konnector-libs')
const Bill = models.bill

const log = require('printit')({
  prefix: 'Bouygues Telecom',
  date: true
})

// Konnector
module.exports = {

  name: 'Bouygues Telecom',
  slug: 'bouyguestelecom',
  description: 'konnector description bouygues',
  vendorLink: 'https://www.bouyguestelecom.fr/',

  category: 'telecom',
  color: {
    hex: '#009DCC',
    css: '#009DCC'
  },

  dataType: ['bill'],

  models: [Bill],

  // Define model requests.
  init (callback) {
    const map = doc => emit(doc.date, doc)
    return Bill.defineRequest('byDate', map, err => callback(err))
  },

  fetch (requiredFields, callback) {
    log.info('Import started')
    return fetcher.new()
      .use(logIn)
      .use(parsePage)
      .use(filterExisting(log, Bill))
      .use(saveDataAndFile(log, Bill, 'bouygues', ['facture']))
      .args(requiredFields, {}, {})
      .fetch(function (err, fields, entries) {
        if (err) { return callback(err) }
        log.info('Import finished')
        return callback()
      })
  }
}

// Procedure to login to Bouygues website.
var logIn = function (requiredFields, bills, data, next) {
  const loginUrl = 'https://www.mon-compte.bouyguestelecom.fr/cas/login'
  const billUrl = 'https://www.bouyguestelecom.fr/parcours/mes-factures/historique'
  const userAgent = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:36.0) ' +
    'Gecko/20100101 Firefox/36.0'

  // First request to grab the login form
  let loginOptions = {
    uri: loginUrl,
    jar: true,
    method: 'GET',
    headers: {
      'User-Agent': userAgent
    }
  }

  log.info('Logging in on Bouygues Website...')
  return request(loginOptions, function (err, res, body) {
    if (err) {
      log.info('Login infos could not be fetched')
      log.info(err)
      return next('bad credentials')
    }

    // Extract hidden values
    const $ = cheerio.load(body)
    const lt = $('input[name="lt"]').val()
    const execution = $('input[name="execution"]').val()

    // Second request to log in (post the form).
    const form = {
      'username': requiredFields.phoneNumber,
      'password': requiredFields.password,
      'lt': lt,
      'execution': execution,
      '_eventId': 'submit'
    }

    loginOptions = {
      method: 'POST',
      form,
      jar: true,
      uri: loginUrl,
      headers: {
        'User-Agent': userAgent
      }
    }

    log.info('Successfully logged in.')
    return request(loginOptions, function (err, res, body) {
      if (err) {
        log.info(err)
        return next('bad credentials')
      }

      log.info('Download bill HTML page...')
      // Third request to build the links of the bills
      const options = {
        method: 'GET',
        uri: billUrl,
        jar: true,
        headers: {
          'User-Agent': userAgent
        }
      }
      return request(options, function (err, res, body) {
        if (err) {
          log.info(err)
          return next('request error')
        }

        data.html = body
        log.info('Bill page downloaded.')
        return next()
      })
    })
  })
}

// Procedure to extract bill data from the page.
var parsePage = function (requiredFields, bills, data, next) {
  let baseDlUrl = 'https://www.bouyguestelecom.fr'
  baseDlUrl += '/parcours/facture/download/index'
  bills.fetched = []

  // Set moment locale for the date parsing
  moment.locale('fr')

  // Load page to make it browseable easily.
  const $ = cheerio.load(data.html)

  // We browse the bills table by processing each line one by one.
  $('.download-facture').each(function () {
    // Markup is not clean, we grab the date from the tag text.
    const date = $(this).text()
      .trim()
      .split(' ')
      .splice(0, 2)
      .join(' ')
      .trim()

    // Amount is in a dirty field. We work on the tag text to extract data.
    let amount = $(this).find('.small-prix').text().trim()
    amount = amount.replace('€', ',')

    // Get the facture id and build the download url from it.
    const id = $(this).attr('facture-id')
    const params =
    {id}
    const url = `${baseDlUrl}?${qs.stringify(params)}`

    // Build bill object.
    const bill = {
      date: moment(date, 'MMMM YYYY').add(14, 'days'),
      amount: amount.replace(',', '.'),
      pdfurl: url
    }
    return bills.fetched.push(bill)
  })

  log.info('Bill data parsed.')
  return next()
}
