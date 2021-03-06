/* globals HTTP */
import UAParser from 'ua-parser-js';

RocketChat.Livechat = {
	historyMonitorType: 'url',

	logger: new Logger('Livechat', {
		sections: {
			webhook: 'Webhook'
		}
	}),

	getNextAgent(department) {
		if (department) {
			return RocketChat.models.LivechatDepartmentAgents.getNextAgentForDepartment(department);
		} else {
			return RocketChat.models.Users.getNextAgent();
		}
	},
	getAgents(department) {
		if (department) {
			return RocketChat.models.LivechatDepartmentAgents.findByDepartmentId(department);
		} else {
			return RocketChat.models.Users.findAgents();
		}
	},
	getOnlineAgents(department) {
		if (department) {
			return RocketChat.models.LivechatDepartmentAgents.getOnlineForDepartment(department);
		} else {
			return RocketChat.models.Users.findOnlineAgents();
		}
	},
	getRoom(guest, message, roomInfo) {
		let room = RocketChat.models.Rooms.findOneById(message.rid);
		let newRoom = false;

		if (room && !room.open) {
			message.rid = Random.id();
			room = null;
		}

		if (room == null) {
			// if no department selected verify if there is at least one active and pick the first
			if (!guest.department) {
				const departments = RocketChat.models.LivechatDepartment.findEnabledWithAgents();
				if (departments.count() > 0) {
					departments.forEach((dept) => {
						if (!guest.department && dept.showOnRegistration) {
							guest.department = dept._id;
						}
					});
				}
			}

			// delegate room creation to QueueMethods
			const routingMethod = RocketChat.settings.get('Livechat_Routing_Method');
			room = RocketChat.QueueMethods[routingMethod](guest, message, roomInfo);

			newRoom = true;
		} else {
			room = Meteor.call('canAccessRoom', message.rid, guest._id);
		}
		if (!room) {
			throw new Meteor.Error('cannot-acess-room');
		}

		return { room, newRoom };
	},
	sendMessage({ guest, message, roomInfo }) {
		const { room, newRoom } = this.getRoom(guest, message, roomInfo);
		if (guest.name) {
			message.alias = guest.name;
		}

		// return messages;
		return _.extend(RocketChat.sendMessage(guest, message, room), { newRoom, showConnecting: this.showConnecting() });
	},
	registerGuest({ token, name, email, department, phone, loginToken, username } = {}) {
		check(token, String);

		let userId;
		const updateUser = {
			$set: {
				profile: {
					guest: true,
					token
				}
			}
		};

		const user = RocketChat.models.Users.getVisitorByToken(token, { fields: { _id: 1 } });

		if (user) {
			userId = user._id;
			if (loginToken) {
				if (!updateUser.$addToSet) {
					updateUser.$addToSet = {};
				}
				updateUser.$addToSet['services.resume.loginTokens'] = loginToken;
			}
		} else {
			if (!username) {
				username = RocketChat.models.Users.getNextVisitorUsername();
			}

			let existingUser = null;

			if (s.trim(email) !== '' && (existingUser = RocketChat.models.Users.findOneGuestByEmailAddress(email))) {
				if (loginToken) {
					if (!updateUser.$addToSet) {
						updateUser.$addToSet = {};
					}
					updateUser.$addToSet['services.resume.loginTokens'] = loginToken;
				}

				userId = existingUser._id;
			} else {

				const userData = {
					username,
					globalRoles: ['livechat-guest'],
					department,
					type: 'visitor',
					joinDefaultChannels: false
				};

				if (this.connection) {
					userData.userAgent = this.connection.httpHeaders['user-agent'];
					userData.ip = this.connection.httpHeaders['x-real-ip'] || this.connection.httpHeaders['x-forwarded-for'] || this.connection.clientAddress;
					userData.host = this.connection.httpHeaders.host;
				}

				userId = Accounts.insertUserDoc({}, userData);

				if (loginToken) {
					updateUser.$set.services = {
						resume: {
							loginTokens: [ loginToken ]
						}
					};
				}
			}
		}

		if (phone) {
			updateUser.$set.phone = [
				{ phoneNumber: phone.number }
			];
		}

		if (email && email.trim() !== '') {
			updateUser.$set.visitorEmails = [
				{ address: email }
			];
		}

		if (name) {
			RocketChat._setRealName(userId, name);
		}

		Meteor.users.update(userId, updateUser);

		return userId;
	},
	setDepartmentForGuest({ token, department } = {}) {
		check(token, String);

		const updateUser = {
			$set: {
				department
			}
		};

		const user = RocketChat.models.Users.getVisitorByToken(token, { fields: { _id: 1 } });
		if (user) {
			return Meteor.users.update(user._id, updateUser);
		}
		return false;
	},
	saveGuest({ _id, name, email, phone }) {
		const updateData = {};

		if (name) {
			updateData.name = name;
		}
		if (email) {
			updateData.email = email;
		}
		if (phone) {
			updateData.phone = phone;
		}
		const ret = RocketChat.models.Users.saveGuestById(_id, updateData);

		Meteor.defer(() => {
			RocketChat.callbacks.run('livechat.saveGuest', updateData);
		});

		return ret;
	},

	closeRoom({ user, room, comment }) {
		const now = new Date();
		RocketChat.models.Rooms.closeByRoomId(room._id, {
			user: {
				_id: user._id,
				username: user.username
			},
			closedAt: now,
			chatDuration: (now.getTime() - room.ts) / 1000
		});

		const message = {
			t: 'livechat-close',
			msg: comment,
			groupable: false
		};

		RocketChat.sendMessage(user, message, room);

		RocketChat.models.Subscriptions.hideByRoomIdAndUserId(room._id, user._id);
		RocketChat.models.Messages.createCommandWithRoomIdAndUser('promptTranscript', room._id, user);

		Meteor.defer(() => {
			RocketChat.callbacks.run('livechat.closeRoom', room);
		});

		return true;
	},

	getInitSettings() {
		const settings = {};

		RocketChat.models.Settings.findNotHiddenPublic([
			'Livechat_title',
			'Livechat_title_color',
			'Livechat_enabled',
			'Livechat_registration_form',
			'Livechat_allow_switching_departments',
			'Livechat_offline_title',
			'Livechat_offline_title_color',
			'Livechat_offline_message',
			'Livechat_offline_success_message',
			'Livechat_offline_form_unavailable',
			'Livechat_display_offline_form',
			'Livechat_videocall_enabled',
			'Jitsi_Enabled',
			'Language',
			'Livechat_enable_transcript',
			'Livechat_transcript_message'
		]).forEach((setting) => {
			settings[setting._id] = setting.value;
		});

		return settings;
	},

	saveRoomInfo(roomData, guestData) {
		if ((roomData.topic != null || roomData.tags != null) && !RocketChat.models.Rooms.setTopicAndTagsById(roomData._id, roomData.topic, roomData.tags)) {
			return false;
		}

		Meteor.defer(() => {
			RocketChat.callbacks.run('livechat.saveRoom', roomData);
		});

		if (!_.isEmpty(guestData.name)) {
			return RocketChat.models.Rooms.setLabelByRoomId(roomData._id, guestData.name) && RocketChat.models.Subscriptions.updateNameByRoomId(roomData._id, guestData.name);
		}
	},

	closeOpenChats(userId, comment) {
		const user = RocketChat.models.Users.findOneById(userId);
		RocketChat.models.Rooms.findOpenByAgent(userId).forEach((room) => {
			this.closeRoom({ user, room, comment});
		});
	},

	forwardOpenChats(userId) {
		RocketChat.models.Rooms.findOpenByAgent(userId).forEach((room) => {
			const guest = RocketChat.models.Users.findOneById(room.v._id);
			this.transfer(room, guest, { departmentId: guest.department });
		});
	},

	savePageHistory(token, pageInfo) {
		if (pageInfo.change === RocketChat.Livechat.historyMonitorType) {
			return RocketChat.models.LivechatPageVisited.saveByToken(token, pageInfo);
		}

		return;
	},

	transfer(room, guest, transferData) {
		let agent;

		if (transferData.userId) {
			const user = RocketChat.models.Users.findOneById(transferData.userId);
			agent = {
				agentId: user._id,
				username: user.username
			};
		} else {
			agent = RocketChat.Livechat.getNextAgent(transferData.departmentId);
		}

		const servedBy = room.servedBy;

		if (agent && agent.agentId !== servedBy._id) {
			room.usernames = _.without(room.usernames, servedBy.username).concat(agent.username);

			RocketChat.models.Rooms.changeAgentByRoomId(room._id, agent);

			const subscriptionData = {
				rid: room._id,
				name: guest.name || guest.username,
				alert: true,
				open: true,
				unread: 0,
				userMentions: 0,
				groupMentions: 0,
				code: room.code,
				u: {
					_id: agent.agentId,
					username: agent.username
				},
				t: 'l',
				desktopNotifications: 'all',
				mobilePushNotifications: 'all',
				emailNotifications: 'all'
			};
			RocketChat.models.Subscriptions.removeByRoomIdAndUserId(room._id, servedBy._id);

			RocketChat.models.Subscriptions.insert(subscriptionData);

			RocketChat.models.Messages.createUserLeaveWithRoomIdAndUser(room._id, { _id: servedBy._id, username: servedBy.username });
			RocketChat.models.Messages.createUserJoinWithRoomIdAndUser(room._id, { _id: agent.agentId, username: agent.username });

			RocketChat.Livechat.stream.emit(room._id, {
				type: 'agentData',
				data: RocketChat.models.Users.getAgentInfo(agent.agentId)
			});

			return true;
		}

		return false;
	},

	sendRequest(postData, callback, trying = 1) {
		try {
			const options = {
				headers: {
					'X-RocketChat-Livechat-Token': RocketChat.settings.get('Livechat_secret_token')
				},
				data: postData
			};
			return HTTP.post(RocketChat.settings.get('Livechat_webhookUrl'), options);
		} catch (e) {
			RocketChat.Livechat.logger.webhook.error(`Response error on ${ trying } try ->`, e);
			// try 10 times after 10 seconds each
			if (trying < 10) {
				RocketChat.Livechat.logger.webhook.warn('Will try again in 10 seconds ...');
				trying++;
				setTimeout(Meteor.bindEnvironment(() => {
					RocketChat.Livechat.sendRequest(postData, callback, trying);
				}), 10000);
			}
		}
	},

	getLivechatRoomGuestInfo(room) {
		const visitor = RocketChat.models.Users.findOneById(room.v._id);
		const agent = RocketChat.models.Users.findOneById(room.servedBy._id);

		const ua = new UAParser();
		ua.setUA(visitor.userAgent);

		const postData = {
			_id: room._id,
			label: room.label,
			topic: room.topic,
			code: room.code,
			createdAt: room.ts,
			lastMessageAt: room.lm,
			tags: room.tags,
			customFields: room.livechatData,
			visitor: {
				_id: visitor._id,
				name: visitor.name,
				username: visitor.username,
				email: null,
				phone: null,
				department: visitor.department,
				ip: visitor.ip,
				os: ua.getOS().name && (`${ ua.getOS().name } ${ ua.getOS().version }`),
				browser: ua.getBrowser().name && (`${ ua.getBrowser().name } ${ ua.getBrowser().version }`),
				customFields: visitor.livechatData
			},
			agent: {
				_id: agent._id,
				username: agent.username,
				name: agent.name,
				email: null
			}
		};

		if (room.crmData) {
			postData.crmData = room.crmData;
		}

		if (visitor.visitorEmails && visitor.visitorEmails.length > 0) {
			postData.visitor.email = visitor.visitorEmails[0].address;
		}
		if (visitor.phone && visitor.phone.length > 0) {
			postData.visitor.phone = visitor.phone[0].phoneNumber;
		}

		if (agent.emails && agent.emails.length > 0) {
			postData.agent.email = agent.emails[0].address;
		}

		return postData;
	},

	addAgent(username) {
		check(username, String);

		const user = RocketChat.models.Users.findOneByUsername(username, { fields: { _id: 1, username: 1 } });

		if (!user) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'livechat:addAgent' });
		}

		if (RocketChat.authz.addUserRoles(user._id, 'livechat-agent')) {
			RocketChat.models.Users.setOperator(user._id, true);
			RocketChat.models.Users.setLivechatStatus(user._id, 'available');
			return user;
		}

		return false;
	},

	addManager(username) {
		check(username, String);

		const user = RocketChat.models.Users.findOneByUsername(username, { fields: { _id: 1, username: 1 } });

		if (!user) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'livechat:addManager' });
		}

		if (RocketChat.authz.addUserRoles(user._id, 'livechat-manager')) {
			return user;
		}

		return false;
	},

	removeAgent(username) {
		check(username, String);

		const user = RocketChat.models.Users.findOneByUsername(username, { fields: { _id: 1 } });

		if (!user) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'livechat:removeAgent' });
		}

		if (RocketChat.authz.removeUserFromRoles(user._id, 'livechat-agent')) {
			RocketChat.models.Users.setOperator(user._id, false);
			RocketChat.models.Users.setLivechatStatus(user._id, 'not-available');
			return true;
		}

		return false;
	},

	removeManager(username) {
		check(username, String);

		const user = RocketChat.models.Users.findOneByUsername(username, { fields: { _id: 1 } });

		if (!user) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', { method: 'livechat:removeManager' });
		}

		return RocketChat.authz.removeUserFromRoles(user._id, 'livechat-manager');
	},

	saveDepartment(_id, departmentData, departmentAgents) {
		check(_id, Match.Maybe(String));

		check(departmentData, {
			enabled: Boolean,
			name: String,
			description: Match.Optional(String),
			showOnRegistration: Boolean
		});

		check(departmentAgents, [
			Match.ObjectIncluding({
				agentId: String,
				username: String
			})
		]);

		if (_id) {
			const department = RocketChat.models.LivechatDepartment.findOneById(_id);
			if (!department) {
				throw new Meteor.Error('error-department-not-found', 'Department not found', { method: 'livechat:saveDepartment' });
			}
		}

		return RocketChat.models.LivechatDepartment.createOrUpdateDepartment(_id, departmentData, departmentAgents);
	},

	removeDepartment(_id) {
		check(_id, String);

		const department = RocketChat.models.LivechatDepartment.findOneById(_id, { fields: { _id: 1 } });

		if (!department) {
			throw new Meteor.Error('department-not-found', 'Department not found', { method: 'livechat:removeDepartment' });
		}

		return RocketChat.models.LivechatDepartment.removeById(_id);
	},

	showConnecting() {
		if (RocketChat.settings.get('Livechat_Routing_Method') === 'Guest_Pool') {
			return RocketChat.settings.get('Livechat_open_inquiery_show_connecting');
		} else {
			return false;
		}
	}
};

RocketChat.Livechat.stream = new Meteor.Streamer('livechat-room');
RocketChat.Livechat.stream.allowRead('logged');

RocketChat.settings.get('Livechat_history_monitor_type', (key, value) => {
	RocketChat.Livechat.historyMonitorType = value;
});
