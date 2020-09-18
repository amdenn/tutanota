// @flow
import m from "mithril"
import {Dialog} from "../gui/base/Dialog"
import type {TextFieldAttrs} from "../gui/base/TextFieldN"
import {TextFieldN, Type} from "../gui/base/TextFieldN"
import type {Language, TranslationKey} from "../misc/LanguageViewModel"
import {lang} from "../misc/LanguageViewModel"
import {formatStorageSize} from "../misc/Formatter"
import type {ConversationTypeEnum} from "../api/common/TutanotaConstants"
import {ALLOWED_IMAGE_FORMATS, ConversationType, FeatureType, Keys, MailMethod, OperationType} from "../api/common/TutanotaConstants"
import {animations, height, opacity} from "../gui/animation/Animations"
import {load} from "../api/main/Entity"
import {Bubble, BubbleTextField} from "../gui/base/BubbleTextField"
import {Editor} from "../gui/base/Editor"
import type {RecipientInfo} from "../api/common/RecipientInfo"
import {isExternal, RecipientInfoType} from "../api/common/RecipientInfo"
import {ConnectionError, PreconditionFailedError, TooManyRequestsError} from "../api/common/error/RestError"
import {UserError} from "../api/common/error/UserError"
import {assertMainOrNode, isApp, Mode} from "../api/Env"
import {PasswordIndicator} from "../gui/base/PasswordIndicator"
import {debounce, downcast, neverNull} from "../api/common/utils/Utils"
import {
	createNewContact,
	createRecipientInfo,
	getDisplayText,
	getEmailSignature,
	replaceCidsWithInlineImages,
	replaceInlineImagesWithCids,
	resolveRecipientInfo,
	resolveRecipientInfoContact
} from "./MailUtils"
import {fileController} from "../file/FileController"
import {contains, findAllAndRemove, remove, replace} from "../api/common/utils/ArrayUtils"
import type {File as TutanotaFile} from "../api/entities/tutanota/File"
import type {Mail} from "../api/entities/tutanota/Mail"
import {ContactEditor} from "../contacts/ContactEditor"
import type {Contact} from "../api/entities/tutanota/Contact"
import {ContactTypeRef} from "../api/entities/tutanota/Contact"
import {isSameId} from "../api/common/EntityFunctions"
import {fileApp} from "../native/FileApp"
import {PermissionError} from "../api/common/error/PermissionError"
import {FileNotFoundError} from "../api/common/error/FileNotFoundError"
import {logins} from "../api/main/LoginController"
import {Icons} from "../gui/base/icons/Icons"
import {DropDownSelector} from "../gui/base/DropDownSelector"
import type {MailAddress} from "../api/entities/tutanota/MailAddress"
import {showProgressDialog} from "../gui/base/ProgressDialog"
import type {MailboxDetail} from "./MailModel"
import {locator} from "../api/main/MainLocator"
import {LazyContactListId} from "../contacts/ContactUtils"
import stream from "mithril/stream/stream.js"
import {isUpdateForTypeRef} from "../api/main/EventController"
import {htmlSanitizer} from "../misc/HtmlSanitizer"
import {RichTextToolbar} from "../gui/base/RichTextToolbar"
import type {ButtonAttrs} from "../gui/base/ButtonN"
import {ButtonColors, ButtonN, ButtonType} from "../gui/base/ButtonN"
import {ExpanderButtonN, ExpanderPanelN} from "../gui/base/ExpanderN"
import {attachDropdown, createDropdown} from "../gui/base/DropdownN"
import {FileOpenError} from "../api/common/error/FileOpenError"
import {client} from "../misc/ClientDetector"
import {formatPrice} from "../subscription/SubscriptionUtils"
import {showUpgradeWizard} from "../subscription/UpgradeSubscriptionWizard"
import {CustomerPropertiesTypeRef} from "../api/entities/sys/CustomerProperties"
import type {InlineImages} from "./MailViewer"
import {getTimeZone} from "../calendar/CalendarUtils"
import {MailAddressBubbleHandler} from "../misc/MailAddressBubbleHandler"
import {newMouseEvent} from "../gui/HtmlUtils"
import type {EncryptedMailAddress} from "../api/entities/tutanota/EncryptedMailAddress"
import {checkApprovalStatus} from "../misc/LoginUtils"
import {SendMailModel, toRecipient} from "./SendMailModel"
import type {DropDownSelectorAttrs} from "../gui/base/DropDownSelectorN"
import {DropDownSelectorN} from "../gui/base/DropDownSelectorN"

assertMainOrNode()

export type Recipient = {name: ?string, address: string, contact?: ?Contact}
export type RecipientList = $ReadOnlyArray<Recipient>
export type Recipients = {to?: RecipientList, cc?: RecipientList, bcc?: RecipientList}

type EditorAttachment = TutanotaFile | DataFile | FileReference

export class MailEditor {
	_model: SendMailModel

	dialog: Dialog;
	_senderField: DropDownSelector<string>;
	toRecipients: BubbleTextField<RecipientInfo>;
	ccRecipients: BubbleTextField<RecipientInfo>;
	bccRecipients: BubbleTextField<RecipientInfo>;
	_editor: Editor;
	_domElement: HTMLElement;
	_domCloseButton: HTMLElement;
	_showToolbar: boolean;
	_richTextToolbar: RichTextToolbar;
	_objectURLs: Array<string>;
	_mentionedInlineImages: Array<string>
	/** HTML elements which correspond to inline images. We need them to check that they are removed/remove them later */
	_inlineImageElements: Array<HTMLElement>
	_detailsExpanded = stream(false)

	_tempBody: string


	/**
	 * Creates a new draft message. Invoke initAsResponse or initFromDraft if this message should be a response
	 * to an existing message or edit an existing draft.
	 *
	 */
	constructor(mailboxDetails: MailboxDetail) {
		this._model = new SendMailModel(logins, locator.mailModel, locator.contactModel, locator.eventController, mailboxDetails)

		this._tempBody = ""

		this.toRecipients = new BubbleTextField("to_label", new MailAddressBubbleHandler(this))
		this.ccRecipients = new BubbleTextField("cc_label", new MailAddressBubbleHandler(this))
		this.bccRecipients = new BubbleTextField("bcc_label", new MailAddressBubbleHandler(this))
		this._showToolbar = false
		this._objectURLs = []
		this._mentionedInlineImages = []
		this._inlineImageElements = []

		this._senderField = new DropDownSelector("sender_label", null, this._model.getEnabledMailAddresses()
		                                                                   .sort().map(mailAddress => ({
				name: mailAddress,
				value: mailAddress
			})), stream(this._model.getDefaultSender()), 250)


		this._editor = new Editor(200, (html, isPaste) => {
			const sanitized = htmlSanitizer.sanitizeFragment(html, !isPaste && this._model._blockExternalContent)
			this._mentionedInlineImages = sanitized.inlineImageCids
			return sanitized.html
		})
		const attachImageHandler = isApp() ? null : (ev) => this._onAttachImageClicked(ev)
		this._richTextToolbar = new RichTextToolbar(this._editor, {imageButtonClickHandler: attachImageHandler})

		if (logins.isInternalUserLoggedIn()) {
			this.toRecipients.textField._injectionsRight = () => m(ExpanderButtonN, {
				label: "show_action",
				expanded: this._detailsExpanded,
			})
			this._editor.initialized.promise.then(() => {
				// TODO
				this._editor.addChangeListener(() => this._model.setMailChanged(true))
			})
		} else {
			this.toRecipients.textField.setDisabled()
			this._editor.initialized.promise.then(() => {
				// TODO
				this._editor.addChangeListener(() => this._model._mailChanged = true)
			})
		}

		// TODO: get rid of this
		this._model._entityEventViewHandler = this._handleEntityEvent

		this.dialog = Dialog.largeDialog({
			left: [
				(attachDropdown({
					label: "close_alt",
					click: () => this._close(),
					type: ButtonType.Secondary,
					oncreate: vnode => this._domCloseButton = vnode.dom
				}, () => [
					{
						label: "discardChanges_action",
						click: () => this._close(),
						type: ButtonType.Dropdown
					},
					{
						label: "saveDraft_action",
						click: () => this.saveDraft(true, true)
						                 .then(() => this._close())
						                 .catch(FileNotFoundError, () => Dialog.error("couldNotAttachFile_msg"))
						                 .catch(PreconditionFailedError, () => Dialog.error("operationStillActive_msg")),
						type: ButtonType.Dropdown
					}
				], () => this._model.hasMailChanged(), 250))
			],
			right: [{label: "send_action", click: () => this.send(), type: ButtonType.Primary}],
			middle: () => lang.get(this._conversationTypeToTitleTextId())
		}, this)
		                    .addShortcut({
			                    key: Keys.ESC,
			                    exec: () => {
				                    attachDropdown({
					                    label: "close_alt",
					                    click: () => this._close(),
					                    type: ButtonType.Secondary,
					                    oncreate: vnode => this._domCloseButton = vnode.dom
				                    }, () => [
					                    {
						                    label: "discardChanges_action",
						                    click: () => this._close(),
						                    type: ButtonType.Dropdown
					                    },
					                    {
						                    label: "saveDraft_action",
						                    click: () => this.saveDraft(true, true)
						                                     .then(() => this._close())
						                                     .catch(FileNotFoundError, () => Dialog.error("couldNotAttachFile_msg"))
						                                     .catch(PreconditionFailedError, () => Dialog.error("operationStillActive_msg")),
						                    type: ButtonType.Dropdown
					                    }
				                    ], () => this._model.hasMailChanged(), 250).click(newMouseEvent(), this._domCloseButton)
			                    },
			                    help: "close_alt"
		                    })
		                    .addShortcut({
			                    key: Keys.B,
			                    ctrl: true,
			                    exec: () => {
				                    // is done by squire
			                    },
			                    help: "formatTextBold_msg"
		                    })
		                    .addShortcut({
			                    key: Keys.I,
			                    ctrl: true,
			                    exec: () => {
				                    // is done by squire
			                    },
			                    help: "formatTextItalic_msg"
		                    })
		                    .addShortcut({
			                    key: Keys.U,
			                    ctrl: true,
			                    exec: () => {
				                    // is done by squire
			                    },
			                    help: "formatTextUnderline_msg"
		                    })
		                    .addShortcut({
			                    key: Keys.S,
			                    ctrl: true,
			                    exec: () => {
				                    this.saveDraft(true, true)
				                        .catch(FileNotFoundError, () => Dialog.error("couldNotAttachFile_msg"))
				                        .catch(PreconditionFailedError, () => Dialog.error("operationStillActive_msg"))
			                    },
			                    help: "save_action"
		                    })
		                    .addShortcut({
			                    key: Keys.S,
			                    ctrl: true,
			                    shift: true,
			                    exec: () => {
				                    this.send()
			                    },
			                    help: "send_action"
		                    }).setCloseHandler(() => attachDropdown({
				label: "close_alt",
				click: () => this._close(),
				type: ButtonType.Secondary,
				oncreate: vnode => this._domCloseButton = vnode.dom
			}, () => [
				{
					label: "discardChanges_action",
					click: () => this._close(),
					type: ButtonType.Dropdown
				},
				{
					label: "saveDraft_action",
					click: () => this.saveDraft(true, true)
					                 .then(() => this._close())
					                 .catch(FileNotFoundError, () => Dialog.error("couldNotAttachFile_msg"))
					                 .catch(PreconditionFailedError, () => Dialog.error("operationStillActive_msg")),
					type: ButtonType.Dropdown
				}
			], () => this._model.hasMailChanged(), 250).click(newMouseEvent(), this._domCloseButton))
	}

	view = () => {
		return m("#mail-editor.full-height.text.touch-callout", {
			oncreate: vnode => {
				this._domElement = vnode.dom
				// TODO
				// windowCloseUnsubscribe = windowFacade.addWindowCloseListener(() =>
				// 	attachDropdown({
				// 		label: "close_alt",
				// 		click: () => this._close(),
				// 		type: ButtonType.Secondary,
				// 		oncreate: vnode => this._domCloseButton = vnode.dom
				// 	}, () => [
				// 		{
				// 			label: "discardChanges_action",
				// 			click: () => this._close(),
				// 			type: ButtonType.Dropdown
				// 		},
				// 		{
				// 			label: "saveDraft_action",
				// 			click: () => this.saveDraft(true, true)
				// 			                 .then(() => this._close())
				// 			                 .catch(FileNotFoundError, () => Dialog.error("couldNotAttachFile_msg"))
				// 			                 .catch(PreconditionFailedError, () => Dialog.error("operationStillActive_msg")),
				// 			type: ButtonType.Dropdown
				// 		}
				// 	], () => this._model.hasMailChanged(), 250).click(newMouseEvent(), this._domCloseButton))
			},
			onremove: vnode => {
				// windowCloseUnsubscribe()
				this._objectURLs.forEach((url) => URL.revokeObjectURL(url))
			},
			onclick: (e) => {
				if (e.target === this._domElement) {
					this._editor.focus()
				}
			},
			ondragover: (ev) => {
				// do not check the datatransfer here because it is not always filled, e.g. in Safari
				ev.stopPropagation()
				ev.preventDefault()
			},
			ondrop: (ev) => {
				if (ev.dataTransfer.files && ev.dataTransfer.files.length > 0) {
					fileController.readLocalFiles(ev.dataTransfer.files).then(dataFiles => {
						this.attachFiles((dataFiles: any))
						m.redraw()
					}).catch(e => {
						console.log(e)
						return Dialog.error("couldNotAttachFile_msg")
					})
					ev.stopPropagation()
					ev.preventDefault()
				}
			}
		}, [
			m(this.toRecipients),
			m(ExpanderPanelN, {expanded: this._detailsExpanded},
				m(".details", [
					m(this.ccRecipients),
					m(this.bccRecipients),
					m(".wrapping-row", [
						m(this._senderField),
						// TODO
						// this._model.getNotificationLanguages()
					]),
				])
			),
			this._model.isConfidential()
				? m(".external-recipients.overflow-hidden", {
					oncreate: vnode => this.animate(vnode.dom, true),
					onbeforeremove: vnode => this.animate(vnode.dom, false)
				}, this._model._allRecipients()
				       .filter(r => r.type === RecipientInfoType.EXTERNAL
					       && !r.resolveContactPromise) // only show passwords for resolved contacts, otherwise we might not get the password
				       .map(r => m(TextFieldN, Object.assign({}, this.getPasswordField(r), {
					       oncreate: vnode => this.animate(vnode.dom, true),
					       onbeforeremove: vnode => this.animate(vnode.dom, false)
				       }))))
				: null,
			m(".row", m(TextFieldN, {
				label: "subject_label",
				helpLabel: () => this.getConfidentialStateMessage(),
				value: this._model._subject,
				injectionsRight: () => {
					return this._model._allRecipients().find(r => r.type === RecipientInfoType.EXTERNAL)
						? [
							m(ButtonN, {
								label: "confidential_action",
								click: () => this._model.setConfidential(!this._model.isConfidential()),
								icon: () => this._model.isConfidential() ? Icons.Lock : Icons.Unlock,
								isSelected: () => this._model.isConfidential(),
								noBubble: true,
							}), m(ButtonN, {
								label: "attachFiles_action",
								click: (ev, dom) => this._showFileChooserForAttachments(dom.getBoundingClientRect()),
								icon: () => Icons.Attachment,
								noBubble: true
							}), ((!logins.getUserController().props.sendPlaintextOnly)
								? m(ButtonN, {
									label: 'showRichTextToolbar_action',
									icon: () => Icons.FontSize,
									click: () => this._showToolbar = !this._showToolbar,
									isSelected: () => this._showToolbar,
									noBubble: true
								})
								: null)
						]
						: [
							m(ButtonN, {
								label: "attachFiles_action",
								click: (ev, dom) => this._showFileChooserForAttachments(dom.getBoundingClientRect()),
								icon: () => Icons.Attachment,
								noBubble: true
							}), ((!logins.getUserController().props.sendPlaintextOnly)
								? m(ButtonN, {
									label: 'showRichTextToolbar_action',
									icon: () => Icons.FontSize,
									click: () => this._showToolbar = !this._showToolbar,
									isSelected: () => this._showToolbar,
									noBubble: true
								})
								: null)
						]
				}
			})),
			m(".flex-start.flex-wrap.ml-negative-bubble", this._getAttachmentButtons().map((a) => m(ButtonN, a))),
			this._model._attachments.length > 0 ? m("hr.hr") : null,
			this._showToolbar
				// Toolbar is not removed from DOM directly, only it's parent (array) is so we have to animate it manually.
				// m.fragment() gives us a vnode without actual DOM element so that we can run callback on removal
				? m.fragment({
					onbeforeremove: ({dom}) => this._richTextToolbar._animate(dom.children[0], false)
				}, [m(this._richTextToolbar), m("hr.hr")])
				: null,
			m(".pt-s.text.scroll-x.break-word-links", {onclick: () => this._editor.focus()}, m(this._editor)),
			m(".pb")
		])
	}


	_getTemplateLanguages(sortedLanguages: Array<Language>): Promise<Array<Language>> {
		return logins.getUserController().loadCustomer()
		             .then((customer) => load(CustomerPropertiesTypeRef, neverNull(customer.properties)))
		             .then((customerProperties) => {
			             return sortedLanguages.filter(sL =>
				             customerProperties.notificationMailTemplates.find((nmt) => nmt.language === sL.code))
		             })
		             .catch(() => [])
	}

	_focusBodyOnLoad() {
		this._editor.initialized.promise.then(() => {
			this._editor.focus()
		})
	}

	_conversationTypeToTitleTextId(): TranslationKey {
		switch (this._model._conversationType) {
			case ConversationType.NEW:
				return "newMail_action"
			case ConversationType.REPLY:
				return "reply_action"
			case ConversationType.FORWARD:
				return "forward_action"
			default:
				return "emptyString_msg"
		}
	}

	animate(domElement: HTMLElement, fadein: boolean) {
		let childHeight = domElement.offsetHeight
		return animations.add(domElement, fadein ? height(0, childHeight) : height(childHeight, 0))
		                 .then(() => {
			                 domElement.style.height = ''
		                 })
	}

	getPasswordField(recipientInfo: RecipientInfo): TextFieldAttrs {
		let passwordIndicator = new PasswordIndicator(() => this._model.getPasswordStrength(recipientInfo))
		let textFieldAttrs = {
			label: () => lang.get("passwordFor_label", {"{1}": recipientInfo.mailAddress}),
			helpLabel: () => m(passwordIndicator),
			value: stream(""),
			type: Type.ExternalPassword
		}
		if (recipientInfo.contact && recipientInfo.contact.presharedPassword) {
			textFieldAttrs.value(recipientInfo.contact.presharedPassword)
		}
		return textFieldAttrs
	}

	initAsResponse({
		               previousMail, conversationType, senderMailAddress,
		               toRecipients, ccRecipients, bccRecipients,
		               attachments, subject, bodyText,
		               replyTos, addSignature, inlineImages,
		               blockExternalContent
	               }: {
		previousMail: Mail,
		conversationType: ConversationTypeEnum,
		senderMailAddress: string,
		toRecipients: MailAddress[],
		ccRecipients: MailAddress[],
		bccRecipients: MailAddress[],
		attachments: TutanotaFile[],
		subject: string,
		bodyText: string,
		replyTos: EncryptedMailAddress[],
		addSignature: boolean,
		inlineImages?: ?Promise<InlineImages>,
		blockExternalContent: boolean
	}): Promise<void> {
		if (addSignature) {
			bodyText = "<br/><br/><br/>" + bodyText
			let signature = getEmailSignature()
			if (logins.getUserController().isInternalUser() && signature) {
				bodyText = signature + bodyText
			}
		}
		if (conversationType === ConversationType.REPLY) {
			this.dialog.setFocusOnLoadFunction(() => this._focusBodyOnLoad())
		}
		let previousMessageId: ?string = null
		const recipients = {
			to: toRecipients.map(toRecipient),
			cc: ccRecipients.map(toRecipient),
			bcc: bccRecipients.map(toRecipient),
		}
		return this._model.initAsResponse({
			previousMail,
			conversationType,
			senderMailAddress,
			recipients,
			attachments,
			subject, bodyText,
			replyTos, addSignature, inlineImages,
			blockExternalContent
		})
	}

	initWithTemplate(recipients: Recipients, subject: string, bodyText: string, confidential: ?boolean, senderMailAddress?: string): Promise<void> {


		// TODO: set focus maybe as .then of initWithTemplate?
		// function toMailAddress({name, address}: {name: ?string, address: string}) {
		// 	return createMailAddress({name: name || "", address})
		// }
		//
		// const toRecipients = recipients.to ? recipients.to.map(toMailAddress) : []
		// if (toRecipients.length) {
		// 	this.dialog.setFocusOnLoadFunction(() => this._focusBodyOnLoad())
		// }
		return this._model.initWithTemplate(recipients, subject, bodyText, confidential, senderMailAddress)

	}

	initWithMailtoUrl(mailtoUrl: string, confidential: boolean): Promise<void> {
		return this._model.initWithMailtoUrl(mailtoUrl, confidential)
	}

	initFromDraft({draftMail, attachments, bodyText, inlineImages, blockExternalContent}: {
		draftMail: Mail,
		attachments: TutanotaFile[],
		bodyText: string,
		blockExternalContent: boolean,
		inlineImages?: Promise<InlineImages>
	}): Promise<void> {
		// We don't want to wait for the editor to be initialized, otherwise it will never be shown
		this._model.initFromDraft({draftMail, attachments, bodyText, inlineImages, blockExternalContent})
		// TODO: check this stuff
		// this._model.initFromDraft(previousMail, confidential, conversationType, previousMessageId, sender.address, toRecipients, ccRecipients, bccRecipients, attachments, subject, bodyText, replyTos)
		//     .then(() => this._replaceInlineImages(inlineImages))
		return Promise.resolve()
	}

	// TODO: call somewhere
	_replaceInlineImages(inlineImages: ?Promise<InlineImages>): void {
		if (inlineImages) {
			inlineImages.then((loadedInlineImages) => {
				Object.keys(loadedInlineImages).forEach((key) => {
					const {file} = loadedInlineImages[key]
					if (!this._model._attachments.includes(file)) this._model._attachments.push(file)
					m.redraw()
				})
				this._editor.initialized.promise.then(() => {
					this._inlineImageElements = replaceCidsWithInlineImages(this._editor.getDOM(), loadedInlineImages, (file, event, dom) => {
						createDropdown(() => [
							{
								label: "download_action",
								click: () => {
									fileController.downloadAndOpen(file, true)
									              .catch(FileOpenError, () => Dialog.error("canNotOpenFileOnDevice_msg"))
								},
								type: ButtonType.Dropdown
							}
						])(downcast(event), dom)
					})
				})
			})
		}
	}

	show() {
		// TODO
		// this is done in the ctor of model
		// this._model._eventController.addEntityListener(this._entityEventReceived)
		this.dialog.show()
	}


	_close() {
		this._model.dispose() // removes model as entity event listener
		this.dialog.close()
	}

	_showFileChooserForAttachments(boundingRect: ClientRect, fileTypes?: Array<string>): Promise<?$ReadOnlyArray<FileReference | DataFile>> {
		if (env.mode === Mode.App) {
			return fileApp
				.openFileChooser(boundingRect)
				.then(files => {
					this.attachFiles((files: any))
					m.redraw()
					return files
				})
				.catch(PermissionError, () => {
					Dialog.error("fileAccessDeniedMobile_msg")
				})
				.catch(FileNotFoundError, () => {
					Dialog.error("couldNotAttachFile_msg")
				})
		} else {
			return fileController.showFileChooser(true, fileTypes).then(files => {
				this.attachFiles((files: any))
				m.redraw()
				return files
			})
		}
	}

	attachFiles(files: Array<TutanotaFile | DataFile | FileReference>): void {
		this._model.attachFiles(files)
		m.redraw()
	}

	_getAttachmentButtons(): Array<ButtonAttrs> {
		return this
			._model._attachments
			// Only show file buttons which do not correspond to inline images in HTML
			.filter((item) => this._mentionedInlineImages.includes(item.cid) === false)
			.map(file => {
				let lazyButtonAttrs: ButtonAttrs[] = []

				lazyButtonAttrs.push({
					label: "download_action",
					type: ButtonType.Secondary,
					click: () => {
						let promise = Promise.resolve()
						if (file._type === 'FileReference') {
							promise = fileApp.open(downcast(file))
						} else if (file._type === "DataFile") {
							promise = fileController.open(downcast(file))
						} else {
							promise = fileController.downloadAndOpen(((file: any): TutanotaFile), true)
						}
						promise
							.catch(FileOpenError, () => Dialog.error("canNotOpenFileOnDevice_msg"))
							.catch(e => {
								const msg = e || "unknown error"
								console.error("could not open file:", msg)
								return Dialog.error("errorDuringFileOpen_msg")
							})
					},
				})

				lazyButtonAttrs.push({
					label: "remove_action",
					type: ButtonType.Secondary,
					click: () => {
						this._model.removeAttachment(file)
						m.redraw()
					}
				})

				return attachDropdown({
					label: () => file.name,
					icon: () => Icons.Attachment,
					type: ButtonType.Bubble,
					staticRightText: "(" + formatStorageSize(Number(file.size)) + ")",
					colors: ButtonColors.Elevated,
				}, () => lazyButtonAttrs)
			})
	}

	// TODO is this purely UI related? idk
	_onAttachImageClicked(ev: Event) {
		this._showFileChooserForAttachments((ev.target: any).getBoundingClientRect(), ALLOWED_IMAGE_FORMATS)
		    .then((files) => {
			    files && files.forEach((f) => {
				    // Let'S assume it's DataFile for now... Editor bar is available for apps but image button is not
				    const dataFile: DataFile = downcast(f)
				    const cid = Math.random().toString(30).substring(2)
				    f.cid = cid
				    const blob = new Blob([dataFile.data], {type: f.mimeType})
				    let objectUrl = URL.createObjectURL(blob)
				    this._objectURLs.push(objectUrl)
				    this._inlineImageElements.push(this._editor.insertImage(objectUrl, {cid, style: 'max-width: 100%'}))
			    })
		    })
	}

	/**
	 * Saves the draft.
	 * @param saveAttachments True if also the attachments shall be saved, false otherwise.
	 * @returns {Promise} When finished.
	 * @throws FileNotFoundError when one of the attachments could not be opened
	 * @throws PreconditionFailedError when the draft is locked
	 */
	saveDraft(saveAttachments: boolean, showProgress: boolean): Promise<void> {
		const body = this._getBody()
		const promise = this._model.saveDraft(body, saveAttachments, MailMethod.NONE)
		if (showProgress) {
			return showProgressDialog("save_msg", promise)
		} else {
			return promise
		}
	}

	_getBody() {
		return this._tempBody == null ? replaceInlineImagesWithCids(this._editor.getDOM()).innerHTML : this._tempBody
	}

	getConfidentialStateMessage() {
		if (this._model.isConfidential()) {
			return lang.get('confidentialStatus_msg')
		} else {
			return lang.get('nonConfidentialStatus_msg')
		}
	}

	send(showProgress: boolean = true, tooManyRequestsError: TranslationKey = "tooManyMails_msg") {
		return Promise
			.resolve()
			.then(() => {
				this.toRecipients.createBubbles()
				this.ccRecipients.createBubbles()
				this.bccRecipients.createBubbles()

				// TODO: See if some of this stuff can't be moved to the model
				// If the text in the textfield hasn't been consumed into bubles it means there was invalid text
				if (this.toRecipients.textField.value().trim() !== "" ||
					this.ccRecipients.textField.value().trim() !== "" ||
					this.bccRecipients.textField.value().trim() !== "") {
					throw new UserError("invalidRecipients_msg")
				}

				let subjectConfirmPromise = Promise.resolve(true)

				if (this._model._subject().trim().length === 0) {
					subjectConfirmPromise = Dialog.confirm("noSubject_msg")
				}
				return subjectConfirmPromise
			})
			.then(confirmed => {
				if (confirmed) {
					if (this._model.isConfidential()
						&& this._model._allRecipients().filter(isExternal).reduce((min, current) =>
							Math.min(min, this._model.getPasswordStrength(current)), 100) < 80) {
						return Dialog.confirm("presharedPasswordNotStrongEnough_msg")
					}
					return true
				} else {
					return false
				}
			})
			.then(confirmed => {
				if (confirmed) {
					const promise = this._model.send(this._getBody(), MailMethod.NONE)
					return showProgress
						? showProgressDialog(this._model.isConfidential() ? "sending_msg" : "sendingUnencrypted_msg", promise)
						: promise
				}
			})
			.catch(UserError, e => Dialog.error(() => e.message))
			.catch(e => {
				console.log(typeof e, e)
				throw e
			})
	}

	/**
	 * @param name If null the name is taken from the contact if a contact is found for the email addrss
	 */
	createBubble(name: ?string, mailAddress: string, contact: ?Contact): Bubble<RecipientInfo> {
		let recipientInfo = createRecipientInfo(mailAddress, name, contact)
		logins.isInternalUserLoggedIn() && resolveRecipientInfoContact(recipientInfo, locator.contactModel, logins.getUserController().user)
		let bubbleWrapper = {}
		bubbleWrapper.buttonAttrs = attachDropdown({
			label: () => getDisplayText(recipientInfo.name, mailAddress, false),
			type: ButtonType.TextBubble,
			isSelected: () => false,
			color: ButtonColors.Elevated
		}, () => {
			if (recipientInfo.resolveContactPromise) {
				return recipientInfo.resolveContactPromise.then(contact => {
					return this._createBubbleContextButtons(recipientInfo.name, mailAddress, contact, () => bubbleWrapper.bubble)
				})
			} else {
				return Promise.resolve(this._createBubbleContextButtons(recipientInfo.name, mailAddress, contact, () => bubbleWrapper.bubble))
			}
		}, undefined, 250)
		resolveRecipientInfo(locator.mailModel, recipientInfo)
			.then(() => m.redraw())
			.catch(ConnectionError, e => {
				// we are offline but we want to show the error dialog only when we click on send.
			})
			.catch(TooManyRequestsError, e => {
				Dialog.error("tooManyAttempts_msg")
			})
		bubbleWrapper.bubble = new Bubble(recipientInfo, neverNull(bubbleWrapper.buttonAttrs), mailAddress)
		return bubbleWrapper.bubble
	}

	_createBubbleContextButtons(name: string, mailAddress: string, contact: ? Contact, bubbleResolver: Function): Array<ButtonAttrs | string> {
		let buttonAttrs = [mailAddress]
		if (logins.getUserController().isInternalUser()) {
			if (!logins.isEnabled(FeatureType.DisableContacts)) {
				if (contact && contact._id) { // the contact may be new contact, in this case do not edit it
					buttonAttrs.push({
						label: "editContact_label",
						type: ButtonType.Secondary,
						click: () => new ContactEditor(contact).show()
					})
				} else {
					buttonAttrs.push({
						label: "createContact_action",
						type: ButtonType.Secondary,
						click: () => {
							LazyContactListId.getAsync().then(contactListId => {
								new ContactEditor(createNewContact(logins.getUserController().user, mailAddress, name), contactListId, contactElementId => {
									let bubbles = [
										this.toRecipients.bubbles, this.ccRecipients.bubbles, this.bccRecipients.bubbles
									].find(b => contains(b, bubbleResolver()))
									if (bubbles) {
										this._updateBubble(bubbles, bubbleResolver(), [contactListId, contactElementId])
									}
								}).show()
							})
						}
					})
				}
			}
			if (!this._model._previousMail
				|| !this._model._previousMail.restrictions
				|| this._model._previousMail.restrictions.participantGroupInfos.length === 0) {
				buttonAttrs.push({
					label: "remove_action",
					type: ButtonType.Secondary,
					click: () => this._removeBubble(bubbleResolver())
				})
			}
		}

		return buttonAttrs
	}

	_handleEntityEvent(update: EntityUpdateData): void {
		const {operation, instanceId, instanceListId} = update
		if (isUpdateForTypeRef(ContactTypeRef, update)
			&& (operation === OperationType.UPDATE || operation === OperationType.DELETE)) {
			let contactId: IdTuple = [neverNull(instanceListId), instanceId]
			let allBubbleLists = [this.toRecipients.bubbles, this.ccRecipients.bubbles, this.bccRecipients.bubbles]
			allBubbleLists.forEach(bubbles => {
				bubbles.forEach(bubble => {
					if (bubble => bubble.entity.contact && bubble.entity.contact._id
						&& isSameId(bubble.entity.contact._id, contactId)) {
						if (operation === OperationType.UPDATE) {
							this._updateBubble(bubbles, bubble, contactId)
						} else {
							this._removeBubble(bubble)
						}
					}
				})
			})
		}
	}

	_updateBubble(bubbles: Bubble<RecipientInfo> [], oldBubble: Bubble<RecipientInfo>, contactId: IdTuple) {
		let emailAddress = oldBubble.entity.mailAddress
		load(ContactTypeRef, contactId).then(updatedContact => {
			if (!updatedContact.mailAddresses.find(ma =>
				ma.address.trim().toLowerCase() === emailAddress.trim().toLowerCase())) {
				// the mail address was removed, so remove the bubble
				remove(bubbles, oldBubble)
			} else {
				let newBubble = this.createBubble(`${updatedContact.firstName} ${updatedContact.lastName}`.trim(), emailAddress, updatedContact)
				replace(bubbles, oldBubble, newBubble)
				// TODO; grab from contact
				if (updatedContact.presharedPassword && this._mailAddressToPasswordField.has(emailAddress)) {
					neverNull(this._mailAddressToPasswordField.get(emailAddress))
						.value(updatedContact.presharedPassword || "")
				}
			}
		})
	}

	_removeBubble(bubble: Bubble<RecipientInfo>) {
		let bubbles = [
			this.toRecipients.bubbles, this.ccRecipients.bubbles, this.bccRecipients.bubbles
		].find(b => contains(b, bubble))
		if (bubbles) {
			remove(bubbles, bubble)
		}
	}

	_languageDropDown(langs: Array<Language>): Children {
		const languageDropDownAttrs: DropDownSelectorAttrs<string> = {
			label: "notificationMailLanguage_label",
			items: langs.map(language => {
				return {name: lang.get(language.textId), value: language.code}
			}),
			selectedValue: () => this._model._selectedNotificationLanguage,
			dropdownWidth: 250
		}
		return m("", this._model.isConfidential()
			? m("", {
				oncreate: vnode => animations.add(vnode.dom, opacity(0, 1, false)),
				onbeforeremove: vnode => animations.add(vnode.dom, opacity(1, 0, false))
			}, m(DropDownSelectorN, languageDropDownAttrs))
			: null
		)
	}

	_cleanupInlineAttachments = debounce(50, () => {
		// Previously we replied on subtree option of MutationObserver to receive info when nested child is removed.
		// It works but it doesn't work if the parent of the nested child is removed, we would have to go over each mutation
		// and check each descendant and if it's an image with CID or not.
		// It's easier and faster to just go over each inline image that we know about. It's more bookkeeping but it's easier
		// code which touches less dome.
		//
		// Alternative would be observe the parent of each inline image but that's more complexity and we need to take care of
		// new (just inserted) inline images and also assign listener there.
		// Doing this check instead of relying on mutations also helps with the case when node is removed but inserted again
		// briefly, e.g. if some text is inserted before/after the element, Squire would put it into another diff and this
		// means removal + insertion.
		const elementsToRemove = []
		this._inlineImageElements.forEach((inlineImage) => {
			if (this._domElement && !this._domElement.contains(inlineImage)) {
				const cid = inlineImage.getAttribute("cid")
				const attachmentIndex = this._model._attachments.findIndex((a) => a.cid === cid)
				if (attachmentIndex !== -1) {
					this._model._attachments.splice(attachmentIndex, 1)
					elementsToRemove.push(inlineImage)
					m.redraw()
				}
			}
		})
		findAllAndRemove(this._inlineImageElements, (imageElement) => elementsToRemove.includes(imageElement))
	})

	_observeEditorMutations() {
		new MutationObserver(this._cleanupInlineAttachments)
			.observe(this._editor.getDOM(), {attributes: false, childList: true, subtree: true})
	}

	static writeSupportMail(subject: string = "") {
		locator.mailModel.init().then(() => {
			if (!logins.getUserController().isPremiumAccount()) {
				const message = lang.get("premiumOffer_msg", {"{1}": formatPrice(1, true)})
				const title = lang.get("upgradeReminderTitle_msg")
				Dialog.reminder(title, message, lang.getInfoLink("premiumProBusiness_link")).then(confirm => {
					if (confirm) {
						showUpgradeWizard()
					}
				})
				return
			}
			return locator.mailModel.getUserMailboxDetails().then((mailboxDetails) => {
				const editor: MailEditor = new MailEditor(mailboxDetails)
				let signature = "<br><br>--"
				signature += "<br>Client: " + client.getIdentifier()
				signature += "<br>Tutanota version: " + env.versionNumber
				signature += "<br>Time zone: " + getTimeZone()
				signature += "<br>User agent:<br>" + navigator.userAgent
				editor.initWithTemplate({to: [{name: null, address: "premium@tutao.de"}]}, subject, signature, true).then(() => {
					editor.show()
				})
			})
		})

	}

	static writeInviteMail() {
		locator.mailModel.getUserMailboxDetails().then((mailboxDetails) => {
			const editor: MailEditor = new MailEditor(mailboxDetails)
			const username = logins.getUserController().userGroupInfo.name;
			const body = lang.get("invitationMailBody_msg", {
				'{registrationLink}': "https://mail.tutanota.com/signup",
				'{username}': username,
				'{githubLink}': "https://github.com/tutao/tutanota"
			})
			editor.initWithTemplate({}, lang.get("invitationMailSubject_msg"), body, false).then(() => {
				editor.show()
			})
		})
	}
}

/**
 * open a MailEditor
 * @param mailboxDetails details to use when sending an email
 * @returns {*}
 * @private
 * @throws PermissionError
 */
export function newMail(mailboxDetails: MailboxDetail): Promise<MailEditor> {
	return checkApprovalStatus(false).then(sendAllowed => {
		if (sendAllowed) {
			let editor: MailEditor = new MailEditor(mailboxDetails)
			editor.initWithTemplate({}, "", "<br/>" + getEmailSignature())
			editor.show()
			return editor
		}
		return Promise.reject(new PermissionError("not allowed to send mail"))
	})
}