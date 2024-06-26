// index.js
// Entry point for West Message web application

// Libraries
const fs = require("fs");
const express = require('express');

// Stripe config
const rawStripeConfig = fs.readFileSync('./.sec/stripe.config', 'utf8');
const stripeConfig = rawStripeConfig.trim();
const stripe = require('stripe')(stripeConfig);

// Twilio config
const twilio = require('twilio');
const MessagingResponse = twilio.twiml.MessagingResponse;
const twilioConfigRaw = fs.readFileSync('./.sec/twilio.json');
const twilioConfig = JSON.parse(twilioConfigRaw);
const twilioClient = new twilio(twilioConfig['accountSID'], twilioConfig['authToken']);

// Firebase imports
const functions = require('firebase-functions');
const { initializeApp, applicationDefault, cert } = require("firebase-admin/app");
const { getAuth } = require( "firebase-admin/auth");
const { getFirestore, Timestamp, FieldValue, Filter } = require( "firebase-admin/firestore");

const { Storage } = require( "@google-cloud/storage");

// Initialize Firebase
const serviceAccountRaw = fs.readFileSync('./.sec/serviceAccountKey.json');
const serviceAccount = JSON.parse(
    // await readFile('./.sec/serviceAccountKey.json')
    serviceAccountRaw
);


initializeApp({
    credential: cert(serviceAccount)
});

// Initialize Firestore db and save reference
const db = getFirestore();
// connectFirestoreEmulator(db, '127.0.0.1', 8080);

// Initialize cloud storage bucket and save reference
const storage = new Storage({
    keyFilename: './.sec/serviceAccountKey.json'
});

// Custom classes
const RecentMessage = require('./RecentMessage.js');

// Constants
const domainName = 'https://westmessage.com/';
const port = 3000;

// Express config
const expApp = express();
expApp.use(express.json({limit: '50mb'}));
expApp.use(express.urlencoded({limit: '50mb', extended: true}));
// expApp.use(express.static('../public')); // Firebase hosting handles this automatically with the public directory


// New user (first sign in immediately after account create / sign up)
expApp.post("/new-user", async(req, res) => {
    const idToken = req.body.userIdToken;

    // Serve setup account settings page if ID token is valid
    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('new-user page accessed by ' + uid);
        res.send(htmlResponse);
      })
      .catch((error) => {
        console.log('Error in new-user: ' + error);
        res.send(htmlResponse);
      });
})


// Setup user (first sign in immediately after account create / sign up)
expApp.post("/setup-user", async(req, res) => {
    const idToken = req.body.userIdToken;

    // Save user settings in database if ID token is valid
    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('setup-user page accessed by ' + uid);

        // Save initial settings to new user doc
        const userData = {firstName: req.body.userFirstName, lastName: req.body.userLastName, phone: req.body.userPhone, email: req.body.userEmail, business: req.body.business, credits: 0, accountTier: 'Free Account'};
        const writeResult = await db.collection('users').doc(uid).set(userData);

        // Atomically assign new user a sendfrom number and save to db
        const assignPhoneNumberTransactionResultIsSuccessful = await db.runTransaction(async (t) => {
            try {
                const phoneNumbersDocument = db.collection('phone-numbers').doc('available-numbers-pool');
                const phoneNumbersDocRef = await t.get(phoneNumbersDocument);
                let availableNumbers = phoneNumbersDocRef.data().availableNumbers;

                let newUsersSendfromNumber;
                if (availableNumbers.length > 0) {
                    newUsersSendfromNumber = availableNumbers.shift();
                }
                else {
                    newUsersSendfromNumber = phoneNumbersDocRef.data().defaultNumber;
                }

                const savedPhoneNumbersDocument = db.collection('phone-numbers').doc('phone-numbers');
                const savedPhoneNumbersDocRef = await t.get(savedPhoneNumbersDocument);
                let numberToUID = savedPhoneNumbersDocRef.data().numberToUID;
                let numbersmap = savedPhoneNumbersDocRef.data().numbersmap;
                numberToUID[newUsersSendfromNumber] = uid;
                numbersmap[uid] = newUsersSendfromNumber;

                const updatedSavedPhoneNumbersData = {numberToUID: numberToUID, numbersmap: numbersmap};
                t.update(savedPhoneNumbersDocument, updatedSavedPhoneNumbersData);

                const updatedPhoneNumbersData = {availableNumbers: availableNumbers};
                t.update(phoneNumbersDocument, updatedPhoneNumbersData);

                return true;

            } catch (error) {
                console.log('Error during setup-user assign phone number: ' + error);
                return false;
            }
        });

        if (!assignPhoneNumberTransactionResultIsSuccessful) {
            res.status(400);
            res.end();
            return;
        }

        // Handle case where user paid for subscription before creating account
        const temporaryUID = req.body.temporaryUID;
        if (temporaryUID != '') {
            // Atomically lookup unredeemed transaction, mark it as redeemed by deleting the entries, and update user account credits and subscription info
            const transactionResultIsSuccessful = await db.runTransaction(async (t) => {
                try {
                    // Lookup transaction in db
                    const paymentsDocument = db.collection('stripe-transactions').doc('unredeemed');
                    const paymentsData = await t.get(paymentsDocument);
                    let unredeemedPayments = paymentsData.data().unredeemedPayments;
                    let unredeemedPaymentsTempUIDMap = paymentsData.data().unredeemedPaymentsTempUIDMap;
                    const stripeSessionID = unredeemedPaymentsTempUIDMap[temporaryUID];

                    // Delete entries now that this subscription is redeemed
                    delete unredeemedPayments[stripeSessionID];
                    delete unredeemedPaymentsTempUIDMap[temporaryUID];

                    // Retrieve Stripe checkout session info
                    const session = await stripe.checkout.sessions.retrieve(stripeSessionID);
                    const lineItems = await stripe.checkout.sessions.listLineItems(stripeSessionID);
                    const subscriptionID = session['subscription'];
                    const purchasedSubscriptionName = lineItems['data'][0]['description'];
                    const numberOfAccountCreditsToAdd = productCreditsMap[purchasedSubscriptionName];

                    const userDocument = db.collection('users').doc(uid);
                    t.update(userDocument, {firstName: req.body.userFirstName, lastName: req.body.userLastName, phone: req.body.userPhone, email: req.body.userEmail, business: req.body.business, credits: numberOfAccountCreditsToAdd, accountTier: purchasedSubscriptionName, subscriptionID: subscriptionID});
                    t.update(paymentsDocument, {unredeemedPayments: unredeemedPayments, unredeemedPaymentsTempUIDMap: unredeemedPaymentsTempUIDMap});
                    return true;

                } catch (error) {
                    console.log('Error during setup-user transaction: ' + error);
                    return false;
                }
            });

            if (!transactionResultIsSuccessful) {
                res.status(400);
                res.end();
                return;
            }
        }

        // Add self to clients list
        const selfClient = {firstname: req.body.userFirstName, lastname: req.body.userLastName, phone: req.body.userPhone, email: req.body.userEmail, company: req.body.business};
        const currentTime = new Date().getTime();
        const clientUID = 'cid-' + currentTime + Math.floor(Math.random() * 100000).toString();
        let clients = {};
        clients[clientUID] = selfClient;
        const writeClientResult = await db.collection('user-clients').doc(uid).set({clients: clients});

        // Create scheduled messages doc in db
        const createScheduledMessagesDocResult = await db.collection('scheduled-messages').doc(uid).set({messages: []});

        res.status(200);
        res.end();
      })
      .catch((error) => {
        console.log('Error in setup-user: ' + error);
        res.status(400);
        res.end();
      });
})


// Get user profile info
expApp.post("/user-info", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
          const uid = decodedToken.uid;
          console.log('user-info page accessed by ' + uid);

          // Read user's info from db
          const userInfoDocument = db.collection('users').doc(uid);
          let userItem = await userInfoDocument.get();
          const firstname = userItem.data().firstName;
          const lastname = userItem.data().lastName;
          const business = userItem.data().business;
          const accountTier = userItem.data().accountTier;
          const credits = userItem.data().credits;

          const sendFromNumber = await getSendFromNumber(uid);

          const dataToSend = JSON.stringify({firstname: firstname, lastname: lastname, business: business, accountTier: accountTier, credits: credits, sendFromNumber: sendFromNumber});
          res.send(dataToSend);
      })
      .catch((error) => {
          console.log('Error in user-info: ' + error);
          const dataToSend = JSON.stringify({firstname: '', lastname: '', business: '', accountTier: '', credits: ''});
          res.send(dataToSend);
      });
})


// Process contact form submission
expApp.post('/contact-form', async (req, res) => {
    const firstName = req.body.clientfname;
    const lastName = req.body.clientlname;
    const phone = req.body.clientphone;
    const email = req.body.clientemail;
    const company = req.body.clientcompany;
    console.log('Contact form submission received');

    // Save details to db
    let currentDateTime = new Date();
    currentDateTime.setMinutes(currentDateTime.getMinutes() - currentDateTime.getTimezoneOffset());
    currentDateTime = currentDateTime.toISOString().slice(0,16);
    const data = {firstName: firstName, lastName: lastName, phone: phone, email: email, business: company, timestamp: currentDateTime};
    const dbRef = db.collection('contact-form-submissions').doc('entries');
    const unionRes = await dbRef.update({
        entries: FieldValue.arrayUnion(data)
    });

    res.end();
});


// Log incoming errors from Twilio webhook
expApp.post('/twerrors', async (req, res) => {
    let errorPayload = req.body.Payload;
    let errorTimestamp = req.body.Timestamp;

    if (!errorPayload || errorPayload == '') errorPayload = 'Empty error payload';
    if (!errorTimestamp || errorTimestamp == '') errorTimestamp = new Date().getTime();

    const newErrorObject = { error: errorPayload, timestamp: errorTimestamp };
    const dbRef = db.collection('errors').doc('twilio-errors');
    const unionRes = await dbRef.update({
        errors: FieldValue.arrayUnion(newErrorObject)
    });

    res.end();
});


// Receive incoming message from Twilio webhook
expApp.post('/wmincoming', async (req, res) => {
    let fromNumber = req.body.From;
    let destinationNumber = req.body.To;
    let messageBody = req.body.Body;

    if (!fromNumber || fromNumber == '') fromNumber = 'Error';
    if (!destinationNumber || destinationNumber == '') destinationNumber = 'Error';
    if (!messageBody || messageBody == '') messageBody = 'Error';

    // Add user to messaging list
    if (messageBody.toLowerCase() == 'join') {
        const phoneNumbersDocument = db.collection('phone-numbers').doc('phone-numbers');
        let dbItem = await phoneNumbersDocument.get();
        const numberToUID = dbItem.data().numberToUID;

        if (numberToUID[destinationNumber]) {
            const listOwnerUID = numberToUID[destinationNumber];

            const dbRef = db.collection('user-messaginglists').doc(listOwnerUID);
            const unionRes = await dbRef.update({
                members: FieldValue.arrayUnion(fromNumber)
            });
        }
    }

    const currentTime = new Date().getTime();
    const newMessageObject = { from: fromNumber, to: destinationNumber, message: messageBody, timestamp: currentTime };
    const dbRef = db.collection('incoming-messages').doc('incoming-messages');
    const unionRes = await dbRef.update({
        messages: FieldValue.arrayUnion(newMessageObject)
    });

    const twiml = new MessagingResponse();
    twiml.message('Thanks for signing up!');

    res.type('text/xml').send(twiml.toString());
});


async function sendMMSWithTwilio(fromNumber, personalizeMessageBody, userMessageImage, recipientNumber, scheduleSendTime, currentMessageUID) {
    // Case 1: schedule send time is not set
    if (scheduleSendTime == '') {
        twilioClient.messages.create({
             body: personalizeMessageBody,
             mediaUrl: [userMessageImage],
             from: fromNumber,
             to: recipientNumber

        }).then(message => console.log(message.sid + ' -> ' + currentMessageUID));
    }
    // Case 2: schedule send time is set
    else if (scheduleSendTime != '') {
        const twilioFormatScheduleSendTime = scheduleSendTime.slice(0,19) + 'Z';
        // console.log('Scheduling message to send on ' + twilioFormatScheduleSendTime);

        twilioClient.messages.create({
             body: personalizeMessageBody,
             mediaUrl: [userMessageImage],
             messagingServiceSid: 'MG2e19a6179490f162a2075d8d1ed270e5',
             to: recipientNumber,
             sendAt: twilioFormatScheduleSendTime,
             scheduleType: 'fixed'

        }).then(message => console.log(message.sid + ' -> ' + currentMessageUID));
    }

}

async function sendSMSWithTwilio(fromNumber, personalizeMessageBody, recipientNumber, scheduleSendTime, currentMessageUID) {
    // Case 1: schedule send time is not set
    if (scheduleSendTime == '') {
        twilioClient.messages.create({
             body: personalizeMessageBody,
             from: fromNumber,
             to: recipientNumber

        }).then(message => console.log(message.sid + ' -> ' + currentMessageUID));
    }
    // Case 2: schedule send time is set
    else if (scheduleSendTime != '') {
        const twilioFormatScheduleSendTime = scheduleSendTime.slice(0,19) + 'Z';
        // console.log('Scheduling message to send on ' + twilioFormatScheduleSendTime);

        twilioClient.messages.create({
             body: personalizeMessageBody,
             messagingServiceSid: 'MG2e19a6179490f162a2075d8d1ed270e5',
             to: recipientNumber,
             sendAt: twilioFormatScheduleSendTime,
             scheduleType: 'fixed'

        }).then(message => console.log(message.sid + ' -> ' + currentMessageUID));
    }
}


// Read user's send from phone number from db
async function getSendFromNumber(uid) {
    const phoneNumbersDocument = db.collection('phone-numbers').doc('phone-numbers');
    let dbItem = await phoneNumbersDocument.get();
    const numbersMap = dbItem.data().numbersmap;

    if (numbersMap[uid]) {
        return numbersMap[uid];
    }
    else {
        return numbersMap['default'];
    }
}


// Send message to user's clients
expApp.post("/send-message", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const currentTime = new Date().getTime();
        const currentMessageUID = 'mid-' + currentTime + Math.floor(Math.random() * 100000).toString();
        const uid = decodedToken.uid;
        const recipientsData = req.body.userRecipients;
        const messageRecipientClientGroups = req.body.messageRecipientClientGroups;
        const userMessage = req.body.userMessage;
        const userMessageImage = req.body.userMessageImage;
        const scheduleSendTime = req.body.scheduleSendTime;
        console.log('send-message request from ' + uid + ': ' + currentMessageUID);

        let userRecipients = [];
        let markRecipientsMap = {}; // Hashmap to avoid duplicate messages (if user uploaded same contact multiple times)
        for (let i = 0; i < recipientsData.length; i++) {
            const phoneNumber = recipientsData[i].split(',')[1];
            if (!markRecipientsMap[phoneNumber]) {
                markRecipientsMap[phoneNumber] = true;
                userRecipients.push(phoneNumber);
            }
        }

        let currentMessageCredits = userRecipients.length;
        if (userMessageImage != null) {
            currentMessageCredits = currentMessageCredits * 5;
        }

        // Atomically update account credits after subtracting credits for this message
        try {
            let accountCredits = 0;

            const transactionResultIsSuccessful = await db.runTransaction(async (t) => {
                // Verify user has enough credits in account to send the message
                const userInfoDocument = db.collection('users').doc(uid);
                const userItem = await t.get(userInfoDocument);
                accountCredits = userItem.data().credits;

                if (accountCredits < currentMessageCredits) {
                    return false;
                }
                else {
                    t.update(userInfoDocument, {credits: accountCredits - currentMessageCredits});
                    return true;
                }
            });

            if (!transactionResultIsSuccessful) {
                res.status(400);
                res.send('Insufficient account credits. Please add more credits to send this message. Your credits: ' + accountCredits + '. Credits needed to send this message: ' + currentMessageCredits + '.');
                return;
            }
        } catch (e) {
            console.log('send-message transaction failure: ' + e);
            res.status(400);
            res.send('Error occurred during send-message transaction');
            return;
        }

        let messageContainsImage = false;
        if (userMessageImage != null) {
            messageContainsImage = true;
        }

        // Save message to db
        const newMessageObject = { messageUID: currentMessageUID, messagebody: userMessage, containsImage: messageContainsImage, recipients: userRecipients, messageRecipientClientGroups: messageRecipientClientGroups, timestamp: currentTime, scheduleSendTime: scheduleSendTime };
        const dbRef = db.collection('users').doc(uid);
        const unionRes = await dbRef.update({
            sentmessages: FieldValue.arrayUnion(newMessageObject)
        });

        // Save message to scheduled messages db if it is scheduled for later
        if (scheduleSendTime != '') {
            const dbRef = db.collection('scheduled-messages').doc(uid);
            const unionRes = await dbRef.update({
                messages: FieldValue.arrayUnion(newMessageObject)
            });
        }

        const sendFromNumber = await getSendFromNumber(uid);

        // Send each message using Twilio API
        for (let i = 0; i < recipientsData.length; i++) {
            const recipientName = recipientsData[i].split(',')[0];
            const recipientNumber = recipientsData[i].split(',')[1];

            // Format personalized messages
            const personalizeMessageBody = userMessage.replaceAll('_NAME_', recipientName);

            // If message has an image attached, save to cloud storage bucket
            if (messageContainsImage) {
               try {
                    // Used for website image rendering (base64)
                    await storage.bucket('sent-images').file(currentMessageUID).save(userMessageImage);

                    // Used for image URL link for MMS messages (decoded base64)
                    const mainChunk = userMessageImage.split(',')[1];
                    const bufferObj = Buffer.from(mainChunk, 'base64');

                    const fileRef = storage.bucket('sent-images').file(currentMessageUID + '_full');
                    await fileRef.save(bufferObj);

                    const config = {
                        action: 'read',
                        // expires: Date.now() + 15 * 60 * 1000, // 15 minutes
                        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days: 7day * 24hr/day * 60min/hr * 60s/min * 1000ms/s
                    };
                     
                    // Get the link to that file
                    fileRef.getSignedUrl(config, function (err, url) {
                        if (err) {
                            console.error(err);
                            res.end();
                            return;
                        }

                        sendMMSWithTwilio(sendFromNumber, personalizeMessageBody, url, recipientNumber, scheduleSendTime, currentMessageUID);
                    });
                } catch (error) {
                    console.log('Error while saving image in send-message: ' + error);
                }
            }
            else {
                sendSMSWithTwilio(sendFromNumber, personalizeMessageBody, recipientNumber, scheduleSendTime, currentMessageUID);
            }
        }

        let successMessage = 'Message sent successfully';
        if (scheduleSendTime != '') {
            successMessage = 'Message scheduled successfully';
        }

        res.status(200);
        res.send(successMessage);
      })
      .catch((error) => {
        console.log('Error in send-message: ' + error);
        res.send('Error while sending message');
      });
})


// Retrieve users scheduled messages
expApp.post("/scheduled-messages", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
          const uid = decodedToken.uid;
          console.log('scheduled-messages page accessed by ' + uid);

          // @TODO: Limit read size
          const scheduledMessagesDocument = db.collection('scheduled-messages').doc(uid);
          let userItem = await scheduledMessagesDocument.get();
          const messages = userItem.data().messages;

          res.send(JSON.stringify({scheduledMessages: messages}));
      })
      .catch((error) => {
          console.log('Error in scheduled-messages: ' + error);
          res.send(JSON.stringify({scheduledMessages: []}));
      });
})


// Return user's previously sent messages
expApp.post("/sent-messages", async(req, res) => {
    const idToken = req.body.userIdToken;

    // Save user settings in database if ID token is valid
    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('sent-messages page accessed by ' + uid);

        // Store MID and timestamp for all of user's messages
        try {
            let recentMessages = [];
            const userDocument = db.collection('users').doc(uid);
            let userItem = await userDocument.get();
            const sentmessages = userItem.data().sentmessages;

            let currentDateTime = new Date();
            currentDateTime.setMinutes(currentDateTime.getMinutes() - currentDateTime.getTimezoneOffset());
            currentDateTime = currentDateTime.toISOString().slice(0,16);

            for (let i = 0; i < sentmessages.length; i++) {
                if (sentmessages[i]['scheduleSendTime'] > currentDateTime) {
                    continue;
                }
                const messageTimestamp = sentmessages[i]['timestamp'];
                recentMessages.push({mid: sentmessages[i]['messageUID'], timestamp: messageTimestamp, index: i});
            }

            // Sort messages by timestamp 
            recentMessages.sort( function(a, b) {
                                     return b['timestamp'] - a['timestamp'];
                                 });

            // Filter down to the 10 most recent messages (actually 50 now)
            let tenMostRecentMessages = [];
            for (let i = 0; i < recentMessages.length; i++) {
                if (i > 50) break;

                const rmUID = sentmessages[recentMessages[i]['index']]['messageUID'];
                const rmBody = sentmessages[recentMessages[i]['index']]['messagebody'];
                const rmContainsImage = sentmessages[recentMessages[i]['index']]['containsImage'];
                const rmRecipients = sentmessages[recentMessages[i]['index']]['recipients'];
                const messageRecipientClientGroups = sentmessages[recentMessages[i]['index']]['messageRecipientClientGroups'];
                const rmTimestamp = sentmessages[recentMessages[i]['index']]['timestamp'];
                // console.log('rmBody: ' + rmBody + ' rmContainsImage: ' + rmContainsImage + ' rmRecipients: ' + rmRecipients + ' rmTimestamp: ' + rmTimestamp);

                tenMostRecentMessages.push(new RecentMessage(rmUID, rmBody, rmContainsImage, rmRecipients, messageRecipientClientGroups, rmTimestamp));
            }

            /*
            console.log('Ten most recent messages');
            for (let i = 0; i < tenMostRecentMessages.length; i++) {
                console.log(tenMostRecentMessages[i]);
            }
             */
            const returnData = JSON.stringify({recentMessages: tenMostRecentMessages});
            res.send(returnData);

        } catch (error) {
            console.log('Error in sent-messages: ' + error);
            res.end();
        }
      })
      .catch((error) => {
        console.log('Error in sent-messages: ' + error);
        res.end();
      });
})


// Retrieve image attached to sent message
expApp.post("/message-image", async(req, res) => {
    const idToken = req.body.userIdToken;

    // Serve setup account settings page if ID token is valid
    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('message-image requested by ' + uid);

        const messageUID = req.body.messageUID;
        let readableContents = '';
        try {
            const contents = await storage.bucket('sent-images').file(messageUID).download();
            readableContents = contents.toString();
        } catch (error) {
            console.log('Error reading message image from ' + uid);
        }

        const returnData = JSON.stringify({image: readableContents});
        res.send(returnData);
      })
      .catch((error) => {
        console.log('Error in message-image: ' + error);
        res.end();
      });
})


// Return user's previously saved clients (and client groups - for now)
expApp.post("/saved-clients", async(req, res) => {
    const idToken = req.body.userIdToken;

    // Save user settings in database if ID token is valid
    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
          const uid = decodedToken.uid;
          console.log('saved-clients page accessed by ' + uid);

          // Read user's saved clients from db
          const userClientsDocument = db.collection('user-clients').doc(uid);
          let userItem = await userClientsDocument.get();
          const clients = userItem.data().clients;

          // Read user's clients that opted in via text
          let opted_in_clients;
          try {
              const messagingListsDocument = db.collection('user-messaginglists').doc(uid);
              let dbItem = await messagingListsDocument.get();
              opted_in_clients = dbItem.data().members;
          } catch (e) {
              opted_in_clients = [];
          }

          // Merge text optins with saved clients list
          for (let i = 0; i < opted_in_clients.length; i++) {
              const currentTime = new Date().getTime();
              const tempClientUID = 'cid-' + currentTime + Math.floor(Math.random() * 100000).toString();
              clients[tempClientUID] = {firstname: 'Text', lastname: 'OptIn', phone: opted_in_clients[i]};
          }

          // Read user's saved client groups from db
          let groups;
          try {
              const userClientGroupsDocument = db.collection('user-clientgroups').doc(uid);
              let userItem2 = await userClientGroupsDocument.get();
              groups = userItem2.data().groups;
          } catch (error) {
              groups = {};
          }

          res.send(JSON.stringify({clients: clients, groups: groups}));
      })
      .catch((error) => {
        console.log('Error in saved-clients: ' + error);
        res.send(JSON.stringify({clients: {}, groups: {}}));
      });
})


// Save user's new client to db
expApp.post("/save-client", async(req, res) => {
    const idToken = req.body.userIdToken;

    // Save user settings in database if ID token is valid
    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
          const uid = decodedToken.uid;
          console.log('save-client requested by ' + uid);

          const newClient = req.body.client;
          const currentTime = new Date().getTime();
          const clientUID = 'cid-' + currentTime + Math.floor(Math.random() * 100000).toString();

          /*
          newClient['clientUID'] = clientUID;
          const dbRef = db.collection('user-clients').doc(uid);
          const unionRes = await dbRef.update({
              clients: FieldValue.arrayUnion(newClient)
          });
           */

          // Read user's clients from db
          const userDocument = db.collection('user-clients').doc(uid);
          let userItem = await userDocument.get();
          let clients;
          try {
              clients = userItem.data().clients;
          } catch (error) {
              clients = {};
          }

          // Write new client back to db
          clients[clientUID] = newClient;
          const dataToWrite = {clients: clients};
          const writeResult = await db.collection('user-clients').doc(uid).set(dataToWrite);

          res.send('Client saved successfully');
      })
      .catch((error) => {
        console.log('Error in save-client: ' + error);
        res.send('Error while saving client');
      });
})


// Save user's clients csv file to cloud storage bucket
expApp.post("/save-clients", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('save-clients page accessed by ' + uid);

        // Read user's clients from db
        const userDocument = db.collection('user-clients').doc(uid);
        let userItem = await userDocument.get();
        let clients;
        try {
            clients = userItem.data().clients;
        } catch (error) {
            clients = {};
        }

        // Create set to eliminate double contact uploads
        let existingClientsNumbersMap = {};
        // for (const currentClient of clients) {
        // for (const [key, val] of clients.entries()) {
        for (const key in clients) {
            existingClientsNumbersMap[clients[key]['phone']] = key;
        }

        // Update clients dictionary
        const newClients = req.body.clients;
        let clientUIDsList = [];
        for (const newClient of newClients) {
            let clientUID;
            if (!existingClientsNumbersMap[newClient['phone']]) {
                const currentTime = new Date().getTime();
                clientUID = 'cid-' + currentTime + Math.floor(Math.random() * 100000).toString();
                existingClientsNumbersMap[newClient['phone']] = clientUID;
                clients[clientUID] = newClient;
            }
            else {
                clientUID = existingClientsNumbersMap[newClient['phone']];
            }

            clientUIDsList.push(clientUID);
        }

        // Write new clients back to db
        const dataToWrite = {clients: clients};
        const writeResult = await db.collection('user-clients').doc(uid).set(dataToWrite);

        // Save clients to client group if default group is not selected
        if (req.body.clientGroupName != 'Default') {
            saveClientsToClientGroup(req, res, clientUIDsList);
        }
        else {
            res.send('Clients saved successfully');
        }
      })
      .catch((error) => {
        console.log('Error in save-clients: ' + error);
        res.send('Error while saving clients');
      });
})


// Remove member from client group
expApp.post("/remove-groupmember", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('remove-groupmember requested by ' + uid);

        const clientUID = req.body.clientUID;
        const groupName = req.body.groupName;

        try {
            // Read user's client groups from db
            let groups;
            try {
                const userClientGroupsDocument = db.collection('user-clientgroups').doc(uid);
                let userItem = await userClientGroupsDocument.get();
                groups = userItem.data().groups;
            } catch (error) {
                groups = {};
            }

            // Delete client UID from group hashmap
            const oldGroupList = groups[groupName];
            let newGroupList = [];
            for (let i = 0; i < oldGroupList.length; i++) {
                if (oldGroupList[i] != clientUID) {
                    newGroupList.push(oldGroupList[i]);
                }
            }
            groups[groupName] = newGroupList;

            // Write new client group list back to db
            const dataToWrite = {groups: groups};
            const writeResult = await db.collection('user-clientgroups').doc(uid).set(dataToWrite);

            res.send('Client was removed from group successfully');
        } catch (error) {
            console.log('Error removing group member');
            res.send('Error removing group member');
        }
      })
      .catch((error) => {
        console.log('Error in remove-groupmember: ' + error);
        res.send('Error removing group member');
      });
})


// Read client groups from db
async function readClientGroups(req, res) {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
          const uid = decodedToken.uid;
          console.log('read-clientgroups request from ' + uid);

          // Read user's client groups from db
          const userDocument = db.collection('user-clientgroups').doc(uid);
          let userItem = await userDocument.get();
          const groups = userItem.data().groups;
          res.send(JSON.stringify({groups: groups}));
      })
      .catch((error) => {
        console.log('Error in read-clientgroups: ' + error);
        res.send('Error while reading client groups');
      });
}


// Read client groups from db endpoint
expApp.post("/read-clientgroups", async(req, res) => {
    readClientGroups(req, res);
})


// Create new client group and save to db
async function saveClientsToClientGroup(req, res, clientUIDs) {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('create-clientgroup request from ' + uid);

        const groupName = req.body.clientGroupName;

        let clients;
        if (clientUIDs) {
            clients = clientUIDs;
        }
        else {
            clients = req.body.clients;
        }

        // Read user's client groups from db
        let groups;
        try {
            const userClientGroupsDocument = db.collection('user-clientgroups').doc(uid);
            let userItem = await userClientGroupsDocument.get();
            groups = userItem.data().groups;
        } catch (error) {
            groups = {};
        }

        let newGroupList = [];
        const oldGroup = groups[groupName];
        if (oldGroup) {
            for (let i = 0; i < clients.length; i++) {
                oldGroup.push(clients[i]);
            }
            const newGroupSet = new Set(oldGroup);
            for (const currentClient of newGroupSet) {
                newGroupList.push(currentClient);
            }
        }
        else {
            newGroupList = clients;
        }

        // Write new client group list back to db
        groups[groupName] = newGroupList;
        const dataToWrite = {groups: groups};
        const writeResult = await db.collection('user-clientgroups').doc(uid).set(dataToWrite);

        /*
        const dbRef = db.collection('user-clientgroups').doc(uid);
        const unionRes = await dbRef.update({
            groups: FieldValue.arrayUnion({groupName: groupName, clients: clients})
        });

        // const fieldToUpdate = eval('groups.' + groupName);
        const setResult = await db.collection('user-clientgroups').doc(uid).update({
             fieldToUpdate: {clients: clients}
        });
         */
        // const setResult = await dbRef.set({groups: [{groupName: groupName, clients: clients}]}, {merge: true});
        // const setResult = await dbRef.set({groups: clients: clients}, {merge: true});

        res.send('Clients group saved successfully');
      })
      .catch((error) => {
        console.log('Error in create-clientgroup: ' + error);
        res.send('Error while creating new client group');
      });
}


// Create new client group and save to db endpoint
expApp.post("/create-clientgroup", async(req, res) => {
    saveClientsToClientGroup(req, res, null);
})


// Process chatbot request
expApp.post("/chatbot-request", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('chatbot-request submitted by ' + uid);

        // Save chatbot request to db
        const currentTime = new Date().getTime();
        const cbrequestUID = 'cbrid-' + currentTime + Math.floor(Math.random() * 100000).toString();
        const chatbotSelection = req.body.chatbotSelection;
        const newChatbotRequest = {cbrequestUID: cbrequestUID, clientUID: uid, chatbotSelection: chatbotSelection};

        const dbRef = db.collection('chatbot-requests').doc('requests');
        const unionRes = await dbRef.update({
            requests: FieldValue.arrayUnion(newChatbotRequest)
        });

        res.send('Chatbot request submitted successfully. Our team will reach out ASAP!');
      })
      .catch((error) => {
        console.log('Error in chatbot request: ' + error);
        res.send('Error while submitting chatbot request');
      });
})


// Process support request
expApp.post("/support-request", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
        const uid = decodedToken.uid;
        console.log('support-request submitted by ' + uid);

        // Save issue to db
        const currentTime = new Date().getTime();
        const issueUID = 'iid-' + currentTime + Math.floor(Math.random() * 100000).toString();
        const issueDescription = req.body.issueDescription;
        const contactMethod = req.body.contactMethod;
        const contactPoint = req.body.contactPoint;
        const poc = req.body.poc;
        const newIssue = {issueUID: issueUID, clientUID: uid, issueDescription: issueDescription, contactMethod: contactMethod, contactPoint: contactPoint, poc: poc};

        const dbRef = db.collection('support-requests').doc('issues');
        const unionRes = await dbRef.update({
            issues: FieldValue.arrayUnion(newIssue)
        });

        res.send('Support request submitted successfully. Our team will reach out ASAP!');
      })
      .catch((error) => {
        console.log('Error in support request: ' + error);
        res.send('Error while submitting support request');
      });
})


// Cancel account subscription with Stripe
expApp.post("/cancel-subscription", async(req, res) => {
    const idToken = req.body.userIdToken;

    getAuth()
      .verifyIdToken(idToken)
      .then( async (decodedToken) => {
          const uid = decodedToken.uid;
          console.log('cancel-subscription request submitted by ' + uid);

          // Read users subscriptionID from db
          const userInfoDocument = db.collection('users').doc(uid);
          let userItem = await userInfoDocument.get();
          const subscriptionID = userItem.data().subscriptionID;

          // Cancel subscription with Stripe
          const deleted = await stripe.subscriptions.cancel(subscriptionID);

          // Update account status in db
          const data = {credits: 0, accountTier: 'Free Account'};
          const writeResult = await db.collection('users').doc(uid).set(data);

          res.send('Subscription has been canceled');
      })
      .catch((error) => {
          console.log('Error in cancel-subscription ' + error);
          res.send('Error while canceling subscription');
      });
})


// Dictionary to map product name to its product ID
// const productIdMap = {'1kcredits': 'price_1NsJDjKF5W6IwfpPf0J1PWsJ', '10kcredits': 'price_1NsJEHKF5W6IwfpPfP2SRIvL'}; // Test mode product mappings
const productIdMap = {'1kcredits': 'price_1Nu11ZKF5W6IwfpP3lKLxi8h', '10kcredits': 'price_1Nu12mKF5W6IwfpPdIDIfXzD'};

// Initiate checkout process to add credits to user account
async function initiateAddAccountCreditsRequest(productName, req, res) {
    const clientUID = req.body.accountinfoclientUID;
    const productID = productIdMap[productName];
    const session = await stripe.checkout.sessions.create({
        line_items: [
            {
                price: productID,
                quantity: 1
            }
        ],
        mode: 'payment',
        success_url: domainName + 'success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: domainName + 'addcreditscancel?session_id={CHECKOUT_SESSION_ID}',
        automatic_tax: {enabled: true},
        client_reference_id: clientUID
    });

    res.redirect(303, session.url);
}

// Initiate Stripe checkout session to add credits to account
expApp.post('/create-checkout-session-add-credits', async (req, res) => {
    const clientUID = req.body.accountinfoclientUID;
    const productName = req.body.amount;
    console.log('Add account credits request from ' + clientUID + ': +' + productName);
    initiateAddAccountCreditsRequest(productName, req, res);
});


// Dictionary to map product name to its value in account credits
const productCreditsMap = {'Classic Plan': 1000, 'Premium Plan': 10000, 'Add 1,000 Credits': 1000, 'Add 10,000 Credits': 10000, 'Test Product 1': 100, 'Alternate Test Product': 1000, '1kcredits': 1000, '10kcredits': 10000};

// Successful Stripe checkout reached
expApp.get('/success', async (req, res) => {
    try {
        // Retrieve Stripe checkout session info
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        const lineItems = await stripe.checkout.sessions.listLineItems(req.query.session_id);
        const sessionID = session['id'];
        // const clientUID = session['client_reference_id'];
        const purchaseMode = session['mode'];
        const subscriptionID = session['subscription'];
        const purchasedSubscriptionName = lineItems['data'][0]['description'];
        const numberOfAccountCreditsToAdd = productCreditsMap[purchasedSubscriptionName];

        // Request will have client_reference_id defined when user goes through signup page. It will not be defined when user goes through pricing page
        let clientUID;
        let tempUID;

        if (session['client_reference_id']) {
            clientUID = session['client_reference_id'];
        }

        // console.log(session);
        // console.log(lineItems);
        // console.log('productName = ' + purchasedSubscriptionName);
        // console.log('Subscription name = ' + purchasedSubscriptionName + ', credits = ' + numberOfAccountCreditsToAdd);

        // Atomically read historical payments, verify payment is valid, save payment, and update user account credits
        try {
            const transactionResultIsSuccessful = await db.runTransaction(async (t) => {
                const paymentDocRef = db.collection('stripe-transactions').doc('all-transactions');
                const paymentsDoc = await t.get(paymentDocRef);
                let payments = paymentsDoc.data().payments;

                // Check if payment is valid
                if (!payments[sessionID]) {
                    payments[sessionID] = true;

                    let whereToSaveCreditsDocRef;
                    let updatedUserInfo;

                    if (session['client_reference_id']) {
                        whereToSaveCreditsDocRef = db.collection('users').doc(clientUID);
                        const userDoc = await t.get(whereToSaveCreditsDocRef);
                        const credits = userDoc.data().credits;

                        if (purchaseMode == 'subscription') {
                            updatedUserInfo = {credits: credits + numberOfAccountCreditsToAdd, accountTier: purchasedSubscriptionName, subscriptionID: subscriptionID};
                        }
                        else {
                            updatedUserInfo = {credits: credits + numberOfAccountCreditsToAdd};
                        }
                    }
                    else {
                        whereToSaveCreditsDocRef = db.collection('stripe-transactions').doc('unredeemed');
                        const undredeemedPaymentsDoc = await t.get(whereToSaveCreditsDocRef);
                        let unredeemedPayments = undredeemedPaymentsDoc.data().unredeemedPayments;

                        if (unredeemedPayments[sessionID]) {
                            return false;
                        }
                        else {
                            unredeemedPayments[sessionID] = true;

                            const currentTime = new Date().getTime();
                            tempUID = 'tuid-' + currentTime + Math.floor(Math.random() * 100000).toString();
                            let unredeemedPaymentsTempUIDMap = undredeemedPaymentsDoc.data().unredeemedPaymentsTempUIDMap;
                            unredeemedPaymentsTempUIDMap[tempUID] = sessionID;

                            updatedUserInfo = {unredeemedPayments: unredeemedPayments, unredeemedPaymentsTempUIDMap: unredeemedPaymentsTempUIDMap};
                        }
                    }

                    t.update(paymentDocRef, {payments: payments});
                    t.update(whereToSaveCreditsDocRef, updatedUserInfo);

                    return true;
                }
                else {
                    return false;
                }
            });

            if (transactionResultIsSuccessful && session['client_reference_id']) {
                console.log('Successful transaction, origin: signup page, sid: ' + sessionID);
                // res.redirect(__dirname + '/public/console.html');
                // res.sendFile(__dirname + '/public/successfulcheckout.html');
                res.send(`<html><body><script>document.location.href = "/console.html";</script></body></html>`);
            }
            else if (transactionResultIsSuccessful && !session['client_reference_id']) {
                console.log('Successful transaction, origin: pricing page, sid: ' + sessionID);
                // res.send(`<html><body><script>document.location.href = "/finish-signup.html";</script></body></html>`);
                // res.setHeader('temporaryUID', tempUID);
                // res.sendFile(__dirname + '/public/finish-signup.html');
                // res.sendFile(__dirname + '/public/intermediary-finish-signup.html');
                res.send(`<html>
                              <head><script src="https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js"></script></head>
                              <body>
                                  <script>
                                      $(document).ready(function() {
                                          document.cookie = "temporaryUID=${tempUID};";
                                          // document.location.href = "/finish-signup.html";
                                          document.location.href = "/signup.html";
                                      });
                                  </script>
                              </body>
                          </html>`);
            }
            else {
                console.log('Invalid transaction');
                res.send(`<html><body><h1>Error occurred</h1></body></html>`);
            }
        } catch (e) {
            console.log('Transaction failure: ' + e);

            const errorTimestamp = new Date().getTime();
            const newErrorObject = { error: e.toString(), timestamp: errorTimestamp };
            const dbRef = db.collection('errors').doc('stripe-errors');
            const unionRes = await dbRef.update({
                errors: FieldValue.arrayUnion(newErrorObject)
            });

            res.send(`<html><body><h1>Error occurred during transaction</h1></body></html>`);
        }
    } catch (error) {
        console.log('Session error: ' + error);

        const errorTimestamp = new Date().getTime();
        const newErrorObject = { error: error.toString(), timestamp: errorTimestamp };
        const dbRef = db.collection('errors').doc('stripe-errors');
        const unionRes = await dbRef.update({
            errors: FieldValue.arrayUnion(newErrorObject)
        });

        res.send(`<html><body><h1>Session error</h1></body></html>`);
    }
});


// Start server with http
/*
expApp.listen(port, function(error) {
    if (error) throw error;
    console.log('Server created successfully on port ' + port);
})
 */

/*
// Start server with https
const httpsKey = await readFile('./.sec/selfsigned.key');
const httpsCert = await readFile('./.sec/selfsigned.crt');
const rawCertPassphrase = await readFile('./.sec/.pf.txt', 'utf8');
const certPassphrase = rawCertPassphrase.trim();

const httpsOptions = {
    key: httpsKey,
    cert: httpsCert,
    passphrase: certPassphrase
};

https.createServer(httpsOptions, expApp).listen(port, function(error) {
    if (error) throw error;
    console.log('Server running on port ' + port);
});
 */

/*
exports.app = onRequest((request, response) => {
  logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});
 */

// export const app = functions.https.onRequest(expApp);
// exports.app = getFunctions.https.onRequest(expApp);
// const app = onRequest(expApp);
// export { app };
// console.log('\n\n\n\n Testing logging \n\n\n\n\n');

let testMode = false;
for (let i = 0; i < process.argv.length; ++i) {
    // console.log(`index ${i} argument -> ${process.argv[i]}`);
    const currentArg = process.argv[i];
    if (currentArg == '--testmode' || currentArg == '-t') {
        testMode = true;
        break;
    }
}

if (!testMode) {
    exports.app = functions.https.onRequest(expApp);
}
else {
    expApp.use(express.static('./../public'));

    expApp.listen(port, function(error) {
        if (error) throw error;
        console.log('Server created successfully on port ' + port);
    })
}

console.log('Application is now running');

