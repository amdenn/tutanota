import m from "mithril"
import stream from "mithril/stream/stream.js"

import {Bubble} from "../gui/base/BubbleTextField"
import type {RecipientInfo} from "../api/common/RecipientInfo"
import type {RecipientInfoBubbleFactory} from "../misc/RecipientInfoBubbleHandler"
import {SendMailModel} from "./SendMailModel"
import type {Contact} from "../api/entities/tutanota/Contact"
import {createNewContact, createRecipientInfo, getDisplayText, resolveRecipientInfo, resolveRecipientInfoContact} from "./MailUtils"
import {attachDropdown} from "../gui/base/DropdownN"
import type {ButtonAttrs} from "../gui/base/ButtonN"
import {ButtonColors, ButtonType} from "../gui/base/ButtonN"
import {neverNull} from "../api/common/utils/Utils"
import {ConnectionError, TooManyRequestsError} from "../api/common/error/RestError"
import {Dialog} from "../gui/base/Dialog"
import {FeatureType} from "../api/common/TutanotaConstants"
import {ContactEditor} from "../contacts/ContactEditor"
import {lazyContactListId} from "../contacts/ContactUtils"

type RecipientInfoBubble = Bubble<RecipientInfo>

// TODO finish this and pass in some logic from the MailEditorN
// can't get much else done until this is completed
export class MailEditorBubbleFactory implements RecipientInfoBubbleFactory {

	model: SendMailModel;
	_onCreateContact: (IdTuple, RecipientInfoBubble) => void;
	_onRemoveRecipient: (RecipientInfoBubble) => void;

	constructor(model: SendMailModel, onCreateContact: (IdTuple, RecipientInfoBubble) => void, onRemoveRecipient: (RecipientInfoBubble) => void) {
		this.model = model
		this._onCreateContact = onCreateContact
		this._onRemoveRecipient = onRemoveRecipient
	}

	/**
	 * @param name If null the name is taken from the contact if a contact is found for the email address
	 * @param mailAddress
	 * @param contact
	 */
	createBubble(name: ?string, mailAddress: string, contact: ?Contact): RecipientInfoBubble {
		this.model.setMailChanged(true)
		let recipientInfo = createRecipientInfo(mailAddress, name, contact)

		if (this.model.logins().isInternalUserLoggedIn()) {
			resolveRecipientInfoContact(recipientInfo, this.model.contacts(), this.model.logins().getUserController().user)
		}

		let bubble: Stream<?RecipientInfoBubble> = stream(null)
		const buttonAttrs = attachDropdown({
				label: () => getDisplayText(recipientInfo.name, mailAddress, false),
				type: ButtonType.TextBubble,
				isSelected: () => false,
				color: ButtonColors.Elevated
			},
			() => recipientInfo.resolveContactPromise
				? recipientInfo.resolveContactPromise.then(
					// TODO check if this is actually nevernull
					contact => this._createRecipientInfoBubbleContextButtons(recipientInfo.name, mailAddress, contact, neverNull(bubble())))
				: Promise.resolve(this._createRecipientInfoBubbleContextButtons(recipientInfo.name, mailAddress, contact, neverNull(bubble()))),
			undefined, 250)

		resolveRecipientInfo(this.model.mails(), recipientInfo)
			.then(() => m.redraw())
			.catch(ConnectionError, e => {
				// we are offline but we want to show the error dialog only when we click on send.
			})
			.catch(TooManyRequestsError, e => {
				Dialog.error("tooManyAttempts_msg")
			})

		bubble(new Bubble(recipientInfo, neverNull(buttonAttrs), mailAddress))
		return neverNull(bubble())
	}


	_createRecipientInfoBubbleContextButtons(name: string, mailAddress: string, contact: ?Contact, bubble: RecipientInfoBubble): Array<ButtonAttrs | string> {
		const canEditBubbleRecipient = this.model.user().isInternalUser() && !this.model.logins().isEnabled(FeatureType.DisableContacts)
		const previousMail = this.model.getPreviousMail()
		const canRemoveBubble = !previousMail || !previousMail.restrictions || previousMail.restrictions.participantGroupInfos.length === 0
		return [
			mailAddress,
			canEditBubbleRecipient
				? contact && contact._id
				? this._makeEditContactButtonAttrs(contact)
				: this._makeCreateContactButtonAttrs(bubble)
				: "",
			canRemoveBubble
				? this._makeRemoveRecipientButtonAttrs(bubble)
				: ""
		]
	}

	_makeEditContactButtonAttrs(contact: Contact): ButtonAttrs {
		return {
			label: "editContact_label",
			type: ButtonType.Secondary,
			click: () => new ContactEditor(contact).show()
		}
	}

	_makeCreateContactButtonAttrs(bubble: RecipientInfoBubble): ButtonAttrs {
		return {
			label: "createContact_action",
			type: ButtonType.Secondary,
			click: () => {
				// contact list
				lazyContactListId(this.model.logins())
					.getAsync()
					.then(contactListId => {
						// TODO should this be passing the stream directly or is it ok to resolve the RecipientInfoBubble here?
						const contactReceiver = (contactElementId) => this._onCreateContact(contactElementId, bubble)
						const newContact = createNewContact(this.model.logins().getUserController().user, bubble.entity.mailAddress, bubble.entity.name)
						new ContactEditor(newContact, contactListId, contactReceiver).show()
					})
				// This is update RecipientInfoBubble function to change or reuse ===================================================================================
				// let RecipientInfoBubbles = [
				// 	this.toRecipients.RecipientInfoBubbles, this.ccRecipients.bubbles, this.bccRecipients.bubbles
				// ].find(b => contains(b, bubble().entity.contact))
				// if (bubbles) {
				// 	const oldBubble = bubble()
				// 	const contactId = [contactListId, contactElementId]
				// 	this._mailChanged = true
				// 	let emailAddress = oldBubble.entity.mailAddress
				// 	load(ContactTypeRef, contactId).then(updatedContact => {
				// 		if (!updatedContact.mailAddresses.find(ma =>
				// 			ma.address.trim().toLowerCase() === emailAddress.trim().toLowerCase())) {
				// 			// the mail address was removed, so remove the bubble
				// 			remove(bubbles, oldBubble)
				// 		} else {
				// 			let newBubble = this.createBubble(`${updatedContact.firstName} ${updatedContact.lastName}`.trim(), emailAddress, updatedContact)
				// 			replace(bubbles, oldBubble, newBubble)
				// 			if (updatedContact.presharedPassword
				// 				&& this._mailAddressToPasswordField.has(emailAddress)) {
				// 				neverNull(this._mailAddressToPasswordField.get(emailAddress))
				// 					.value(updatedContact.presharedPassword || "")
				// 			}
				// 		}
				// 	})
				// =====================================================================================================================================
				// }

			}
		}
	}

	_makeRemoveRecipientButtonAttrs(bubble: RecipientInfoBubble): ButtonAttrs {
		return {
			label: "remove_action",
			type: ButtonType.Secondary,
			click: () => this._onRemoveRecipient(bubble)
			// click: () => {
			// 	const RecipientInfoBubble = RecipientInfoBubbleResolver()
			// 	this._mailChanged = true
			// 	let RecipientInfoBubbles = [
			// 		this.toRecipients.RecipientInfoBubbles, this.ccRecipients.RecipientInfoBubbles, this.bccRecipients.RecipientInfoBubbles
			// 	].find(b => contains(b, RecipientInfoBubble))
			// 	if (RecipientInfoBubbles) {
			// 		remove(RecipientInfoBubbles, RecipientInfoBubble)
			// 	}
			// }
		}
	}

}
