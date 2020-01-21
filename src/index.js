// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://911e993f78084056acd7573dd2c02796:4516f6bd679d467db06aa35b84b3984b@sentry.cozycloud.cc/21'

const moment = require('moment')
const jwt = require('jwt-decode')

const {
  BaseKonnector,
  requestFactory,
  log,
  signin,
  cozyClient,
  utils
} = require('cozy-konnector-libs')

const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})

module.exports = new BaseKonnector(async function fetch(fields) {
  if (!fields.lastname) {
    log('debug', 'Name not set, auth could fail trough some IP')
  }
  const baseUrl = 'https://api.bouyguestelecom.fr'
  const { idPersonne, accessToken } = await logIn(fields)
  log('info', 'Login succeed')

  const authRequest = request.defaults({
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  const personnes = await authRequest(`${baseUrl}/personnes/${idPersonne}`)
  const linkFactures = personnes._links.factures.href
  const comptes = await authRequest(`${baseUrl}${linkFactures}`)
  log(
    'info',
    `${comptes.comptesFacturation.length} comptes found, maybe some are empties`
  )

  // Try extracting Name of personnes object
  if (fields.lastname) {
    log('debug', 'Lastname already set, do nothing')
  } else {
    log('debug', 'Extracting lastame from website')
    const name = tryNameExtraction(personnes)
    log('debug', 'Setting lastname in account')
    try {
      setName(name, this.accountId)
    } catch (e) {
      log('warn', 'Error when setting account')
      log('warn', e.msg ? e.msg : e)
    }
  }

  const prefixListOfImportedFiles = []
  for (let compte of comptes.comptesFacturation) {
    // Some compteFacturation are empty of 'factures'
    for (let facture of compte.factures) {
      // Fetch the facture url to get a json containing the definitive pdf url
      // If facturePDF is not define, it seems facturePDFDF is ok
      let result
      if (facture._links.facturePDF !== undefined) {
        result = await authRequest(
          `${baseUrl}${facture._links.facturePDF.href}`
        )
      } else {
        result = await authRequest(
          `${baseUrl}${facture._links.facturePDFDF.href}`
        )
      }
      const factureUrl = `${baseUrl}${result._actions.telecharger.action}`
      // Call each time because of quick link expiration (~1min)
      prefixListOfImportedFiles.push(
        moment(facture.dateFacturation).format('YYYYMM') + '_'
      )
      await this.saveBills(
        [
          {
            vendor: 'Bouygues',
            date: new Date(facture.dateFacturation),
            amount: facture.mntTotFacture,
            vendorRef: facture.idFacture,
            fileurl: factureUrl,
            filename: getFileName(
              facture.dateFacturation,
              facture.mntTotFacture,
              facture.idFacture
            ),
            currency: '€',
            fileAttributes: {
              metadata: {
                classification: 'invoicing',
                datetime: new Date(facture.dateFacturation),
                datetimeLabel: 'issueDate',
                contentAuthor: 'bouygues',
                subClassification: 'invoice',
                categories: ['phone'],
                issueDate: new Date(facture.dateFacturation),
                invoiceNumber: facture.idFacture,
                contractReference: compte.id,
                isSubscription: true
              }
            }
          }
        ],
        fields,
        {
          sourceAccount: this.accountId,
          sourceAccountIdentifier: fields.login,
          fileIdAttributes: ['vendorRef'],
          keys: ['vendorRef'],
          linkBankOperations: false
        }
      )
    }
    // Clean old files
    await cleanOldFiles(prefixListOfImportedFiles, fields)
  }
})

// Procedure to login to Bouygues website.
async function logIn({ login, password, lastname }) {
  await signin({
    url: 'https://www.mon-compte.bouyguestelecom.fr/cas/login',
    formSelector: 'form',
    formData: { username: login, password, lastname },
    simple: false,
    validate: (statusCode, $) => {
      if (
        $.html().includes(
          'Votre identifiant ou votre mot de passe est incorrect'
        )
      ) {
        return false
      } else {
        return true
      }
    }
  })
  log('debug', `First login succeed, asking for more API rights`)
  // Acredite token for downloading file via the API
  const resp = await request(
    'https://oauth2.bouyguestelecom.fr/authorize?client_id=a360.bouyguestelecom.fr&response_type=id_token%20token&redirect_uri=https%3A%2F%2Fwww.bouyguestelecom.fr%2Fmon-compte%2F',
    {
      resolveWithFullResponse: true
    }
  )
  log('debug', `Returned http code ${resp.statusCode}`)
  log('debug', 'Extracting token from request')
  if (resp.request.uri.href.includes('https://oauth2.bouyguestelecom')) {
    log('error', 'Api right enhancement failed, redirect to auth')
    throw new Error('LOGIN_FAILED.NEEDS_SECRET')
  } else {
    const href = resp.request.uri.href.split('=')
    const accessToken = href[1].split('&')[0]
    // Better extraction than split because base64 include some =
    log('debug', 'Extracting personne from jsonwebtoken jwt')
    const jwtString = resp.request.uri.href.match(/id_token=(.*)$/)[1]
    const idPersonne = jwt(jwtString).id_personne
    return { idPersonne, accessToken }
  }
}

function getFileName(date, amount, factureId) {
  return `${moment(date).format('YYYYMM')}_bouygues_${amount.toFixed(
    2
  )}€_${factureId}.pdf`
}

function tryNameExtraction(personnes) {
  if (personnes.nom.length > 0) {
    return personnes.nom
  } else {
    log('warn', 'Name seems empty, impossible to set')
  }
}

async function setName(name, accountId) {
  let accountObj = await cozyClient.data.find('io.cozy.accounts', accountId)
  accountObj.auth.lastname = name
  await cozyClient.data.update('io.cozy.accounts', accountObj, accountObj)
}

async function cleanOldFiles(prefixList, fields) {
  let billsToDelete = []
  const parentDir = await cozyClient.files.statByPath(fields.folderPath)
  const filesAndDirList = await utils.queryAll('io.cozy.files', {
    dir_id: parentDir._id
  })
  const filesList = filesAndDirList.filter(file => file.type === 'file')
  const bills = await utils.queryAll('io.cozy.bills', {
    vendor: 'Bouygues Telecom'
  })

  for (const file of filesList) {
    const prefix = file.name.slice(0, 7) // Is something like 201901_
    // Prefix is found and a special string is present, it's an old file
    // that's haven't been rename or move by the user
    if (
      prefixList.includes(prefix) &&
      (file.name.includes('bouyguesBox') ||
        file.name.includes('bouyguestelecom'))
    ) {
      await cozyClient.files.trashById(file._id)
      const bill = isABillMatch(file, bills)
      if (bill) {
        billsToDelete.push(bill)
      }
    }
  }
  // Deleting all necessary bills at once
  await utils.batchDelete('io.cozy.bills', billsToDelete)
}

/* Return the first bill matching the file passed
 */
function isABillMatch(file, bills) {
  for (const bill of bills) {
    if (bill.invoice === `io.cozy.files:${file._id}`) {
      return bill
    }
  }
  return false
}
