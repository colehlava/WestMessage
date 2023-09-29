// export class RecentMessage {
class RecentMessage {

    constructor(messageUID, messagebody, containsImage, recipients, messageRecipientClientGroups, timestamp) {
        this.messageUID = messageUID;
        this.messagebody = messagebody;
        this.containsImage = containsImage;
        this.recipients = recipients;
        this.messageRecipientClientGroups = messageRecipientClientGroups;
        this.timestamp = timestamp;
    }
}

module.exports = RecentMessage;

