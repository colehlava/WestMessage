// index.js
// Entry point for Text My Clients web application

// Libraries
import { default as fs } from 'fs';
import { readFile } from 'fs/promises';
import { default as express } from 'express';
// import * as http from 'http';
import { default as https } from 'https';

import { dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Stripe config
import { Stripe } from 'stripe';
const stripe = new Stripe('sk_test_51NralMKF5W6IwfpPSMKwDqlxIQVvAbDNSlwK8L5INDdaZjcW7roOsrohtOshzGT7pghpTbOYtzoxvxhc5hrxtRCf00UTBAiuA5');


// Twilio config
import { default as twilio } from 'twilio';
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

// Firebase imports
// import { initializeApp } from "firebase/app";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app"; // @TODO: maybe delete applicationDefault import
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp, FieldValue, Filter } from "firebase-admin/firestore";
// import { getStorage } from "firebase-admin/storage";
// import { ref, uploadBytesResumable } from "firebase/storage";
// import { getStorage, getDownloadURL } from "firebase-admin/storage";
import { Storage } from "@google-cloud/storage";

// Initialize Firebase
const serviceAccount = JSON.parse(
  await readFile('./.sec/serviceAccountKey.json')
);

initializeApp({
    credential: cert(serviceAccount) // ,
    // storageBucket: 'https://console.firebase.google.com/project/textproject-91e54/storage/textproject-91e54.appspot.com/files'
});

// Initialize Firestore db and save reference
const db = getFirestore();

// Initialize cloud storage bucket and save reference
// const storage = getStorage(app);
// const storage = getStorage();
const storage = new Storage();

// Custom classes
import { RecentMessage } from './RecentMessage.js';

// Constants
const expApp = express();
const domainName = 'https://localhost:3000/';
const port = 3000;
const apiLimitSize = 200;

// Express config
// @TODO: Finalize request size limits
expApp.use(express.json({limit: '50mb'}));
expApp.use(express.urlencoded({limit: '50mb', extended: true}));
expApp.use(express.static('public'));


// Home page
expApp.get("/", function(req, res) {
    console.log("home page accessed");
    // fs.createReadStream('landing.html').pipe(res);
    res.sendFile(__dirname + '/landing.html');
})


// @TODO: maybe delete, also verify htmlResponse definition
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

        const data = {firstName: req.body.userFirstName, lastName: req.body.userLastName, phone: req.body.userPhone, email: req.body.userEmail, business: req.body.business, credits: 0, accountTier: 'free'};
        const writeResult = await db.collection('users').doc(uid).set(data);

        const createScheduledMessagesDocResult = await db.collection('scheduled-messages').doc(uid).set({messages: []});

        // Create user-clients doc for new user
        // const writeClientsResult = await db.collection('user-clients').doc(uid).set({clients: []});

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

          const dataToSend = JSON.stringify({firstname: firstname, lastname: lastname, business: business, accountTier: accountTier, credits: credits});
          res.send(dataToSend);
      })
      .catch((error) => {
          console.log('Error in user-info: ' + error);
          const dataToSend = JSON.stringify({firstname: '', lastname: '', business: '', accountTier: '', credits: ''});
          res.send(dataToSend);
      });
})


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

        const currentMessageCredits = userRecipients.length; // @TODO: calculate message credits value
        let accountCredits;

        // Atomically update account credits after subtracting credits for this message
        try {
            const transactionResultIsSuccessful = await db.runTransaction(async (t) => {
                // Verify user has enough credits in account to send the message
                const userInfoDocument = db.collection('users').doc(uid);
                let userItem = await userInfoDocument.get();
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
            console.log('send-message transaction failure: ', e);
            res.status(400);
            res.send('Error occurred during send-message transaction');
            return;
        }

        // If message has an image attached, save to cloud storage bucket
        let messageContainsImage = false;
        if (userMessageImage != null) {
            messageContainsImage = true;
            await storage.bucket('sentimages').file(currentMessageUID).save(userMessageImage);
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


        // @TODO: Integrate Twilio API to send text messages
        // Send each message using Twilio API
        for (let i = 0; i < recipientsData.length; i++) {
            const recipientName = recipientsData[i].split(',')[0];
            const recipientNumber = recipientsData[i].split(',')[1];

            // Format personalized messages
            const personalizeMessageBody = userMessage.replaceAll('_NAME_', recipientName);
            console.log(personalizeMessageBody);

            // sendTwilioMessage(personalizeMessageBody, recipientNumber);
        }

        res.status(200);
        res.send('Message sent successfully');
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

          // @TODO: read scheduled messages from db
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

        /*
        // Get user's phone number from db
        let userPhone;
        try {
            const userDocument = db.collection('users').doc(uid);
            let userItem = await userDocument.get();
            userPhone = userItem.data().phone;
        } catch (error) {
            console.log(error);
        }
         */

        // Use default number for now
        // @TODO: Uncomment above db read after implementing account tiers
        let userPhone = '+18669124067';

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
                /*
                const rmBody = sentmessages[recentMessages[i]['index']]['message']['messagebody'];
                const rmContainsImage = sentmessages[recentMessages[i]['index']]['message']['containsImage'];
                const rmRecipients = sentmessages[recentMessages[i]['index']]['message']['recipients'];
                const rmTimestamp = sentmessages[recentMessages[i]['index']]['message']['timestamp'];
                 */
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
            // res.status(200);
            res.send(returnData);

        } catch (error) {
            console.log('Error in sent-messages: ' + error);
            // res.status(400); // @TODO: make sure this is in fact how it should be handled
            res.end();
        }
      })
      .catch((error) => {
        console.log('Error in sent-messages: ' + error);
        // res.status(400); // @TODO: make sure this is in fact how it should be handled
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
            const contents = await storage.bucket('sentimages').file(messageUID).download();
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

          // Read user's clients from db
          const userClientsDocument = db.collection('user-clients').doc(uid);
          let userItem = await userClientsDocument.get();
          const clients = userItem.data().clients;

          // Read user's client groups from db
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

        /*
        // Write csv file to cloud storage bucket
        const inputFile = req.body.userInputFile;
        console.log(inputFile);
        await storage.bucket('user-clients').file(uid + '.csv').save(inputFile);
         */

        /*
        // Save clients to db (currently only works when saving one client at a time)
        let clientUIDsList = [];
        const clients = req.body.clients;
        const dbRef = db.collection('user-clients').doc(uid);
        for (let i = 0; i < clients.length; i++) {
            const currentTime = new Date().getTime();
            const clientUID = 'cid-' + currentTime + Math.floor(Math.random() * 100000).toString();
            clientUIDsList.push(clientUID);
            clients[i]['clientUID'] = clientUID;
            const unionRes = await dbRef.update({
                clients: FieldValue.arrayUnion(clients[i])
            });
        }
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

        // Update clients dictionary
        const newClients = req.body.clients;
        let clientUIDsList = [];
        for (const newClient of newClients) {
            const currentTime = new Date().getTime();
            const clientUID = 'cid-' + currentTime + Math.floor(Math.random() * 100000).toString();
            clientUIDsList.push(clientUID);
            clients[clientUID] = newClient;
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
          const data = {credits: 0, accountTier: 'free'};
          const writeResult = await db.collection('users').doc(uid).set(data);

          res.send('Subscription has been canceled');
      })
      .catch((error) => {
          console.log('Error in cancel-subscription ' + error);
          res.send('Error while canceling subscription');
      });
})


// Dictionary to map product name to its product ID
const productIdMap = {'1kcredits': 'price_1NsJDjKF5W6IwfpPf0J1PWsJ', '10kcredits': 'price_1NsJEHKF5W6IwfpPfP2SRIvL'};

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
const productCreditsMap = {'Test Product 1': 100, 'Alternate Test Product': 1000, '1kcredits': 1000, '10kcredits': 10000};

// Successful Stripe checkout reached
expApp.get('/success', async (req, res) => {
    try {
        // Retrieve Stripe checkout session info
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        const lineItems = await stripe.checkout.sessions.listLineItems(req.query.session_id);
        const sessionID = session['id'];
        const clientUID = session['client_reference_id'];
        const purchaseMode = session['mode'];
        const subscriptionID = session['subscription'];
        const purchasedSubscriptionName = lineItems['data'][0]['description'];
        const numberOfAccountCreditsToAdd = productCreditsMap[purchasedSubscriptionName];

        // console.log(session);
        // console.log(lineItems);
        console.log('productName = ' + purchasedSubscriptionName);
        // console.log('Subscription name = ' + purchasedSubscriptionName + ', credits = ' + numberOfAccountCreditsToAdd);

        // Atomically read historical payments, verify payment is valid, save payment, and update user account credits
        try {
            const transactionResultIsSuccessful = await db.runTransaction(async (t) => {
                const paymentDocRef = db.collection('payment-transactions').doc('payment-transactions');
                const doc = await t.get(paymentDocRef);
                const payments = doc.data().payments;

                // Add credits to user account if payment is valid
                if (!payments[sessionID]) {
                    payments[sessionID] = true;

                    const usersDocRef = db.collection('users').doc(clientUID);
                    const userDoc = await t.get(usersDocRef);
                    const credits = userDoc.data().credits;

                    let updatedUserInfo;
                    if (purchaseMode == 'subscription') {
                        updatedUserInfo = {credits: credits + numberOfAccountCreditsToAdd, accountTier: purchasedSubscriptionName, subscriptionID: subscriptionID};
                    }
                    else {
                        updatedUserInfo = {credits: credits + numberOfAccountCreditsToAdd};
                    }

                    t.update(paymentDocRef, {payments: payments});
                    t.update(usersDocRef, updatedUserInfo);
                    return true;
                }
                else {
                    return false;
                }
            });

            if (transactionResultIsSuccessful) {
                console.log('Successful transaction from ' + clientUID + ', sid: ' + sessionID);
                // res.send(`<html><body><h1>Thanks for your order!</h1></body></html>`);
                // res.redirect(__dirname + '/public/console.html');
                res.sendFile(__dirname + '/public/successfulcheckout.html');
            }
            else {
                console.log('Invalid transaction from ' + clientUID + ', sid: ' + sessionID);
                res.send(`<html><body><h1>Error occurred</h1></body></html>`);
            }
        } catch (e) {
            console.log('Transaction failure: ', e);
            res.send(`<html><body><h1>Error occurred during transaction</h1></body></html>`);
        }
    } catch (error) {
        console.log('Session error: ', error);
        res.send(`<html><body><h1>Session error</h1></body></html>`);
    }
});


/*
// Start server with http
expApp.listen(port, function(error) {
    if (error) throw error;
    console.log('Server created successfully on port ' + port);
})
 */

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

