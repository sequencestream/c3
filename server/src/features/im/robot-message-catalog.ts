/**
 * Server-side robot safety message templates. Independent from Web vue-i18n;
 * shares only the short language codes en/zh/ja/ko/ru with the UI pipeline.
 */
import type { UiLang } from '@ccc/shared/protocol'

export const ROBOT_MESSAGE_LOCALES = ['en', 'zh', 'ja', 'ko', 'ru'] as const
export type RobotMessageLocale = (typeof ROBOT_MESSAGE_LOCALES)[number]

export const ROBOT_MESSAGE_BASE_LOCALE: RobotMessageLocale = 'en'

/** Dot-separated stable keys — server-internal contract, never exposed on the wire. */
export const ROBOT_MESSAGE_KEYS = [
  'system.safeFallback',
  'binding.identityRequired',
  'binding.identityRequiredGroup',
  'binding.useDm',
  'binding.success',
  'binding.failed',
  'binding.tokenUnusable',
  'binding.scopeChanged',
  'visibility.notVisible',
  'visibility.groupAllHidden',
  'visibility.groupPartiallyHidden',
  'visibility.capabilityDenied',
  'visibility.webRequired',
  'token.expired',
  'token.consumed',
  'token.cancelled',
  'token.unusable',
  'token.wrongChat',
  'todo.answerFormatHint',
  'todo.grantMissing',
  'todo.alreadyApplied',
  'todo.applied',
  'todo.l2Prompt',
  'runtime.timeout',
  'runtime.blocked',
  'runtime.error',
  'runtime.guardRefused',
  'runtime.busy',
  'runtime.storeUnavailable',
  'runtime.inputRejectedCredential',
  'runtime.inputRejectedTooLong',
  'runtime.securityError',
  'navigation.webEntry.linked',
  'navigation.webEntry.plain',
  'navigation.objectDeepLink.linked',
  'navigation.objectDeepLink.plain',
  'broadcast.automationPaused',
  'broadcast.automationSilentTimeout',
  'broadcast.automationRetriesExhausted',
  'broadcast.specPendingReview',
  'broadcast.permissionRequestQueued',
  'broadcast.deliveryPendingReview',
  'broadcast.mainlineDrift',
] as const

export type RobotMessageKey = (typeof ROBOT_MESSAGE_KEYS)[number]

export type MessageCatalogEntry = {
  /** Placeholder names allowed in this template, e.g. link, totalCount, title. */
  placeholders: readonly string[]
  templates: Record<RobotMessageLocale, string>
}

export const ROBOT_MESSAGE_CATALOG: Record<RobotMessageKey, MessageCatalogEntry> = {
  'system.safeFallback': {
    placeholders: [],
    templates: {
      en: 'This action cannot be completed here. Open c3 Web to continue.',
      zh: '无法在此完成该操作。请在浏览器中打开 c3 Web 继续。',
      ja: 'ここでは完了できません。c3 Web をブラウザで開いて続行してください。',
      ko: '여기서는 완료할 수 없습니다. 브라우저에서 c3 Web을 열어 계속하세요.',
      ru: 'Здесь действие выполнить нельзя. Откройте c3 Web в браузере, чтобы продолжить.',
    },
  },
  'binding.identityRequired': {
    placeholders: ['link'],
    templates: {
      en: 'Bind your IM identity in c3 Web Personal settings, then send the one-time code to this robot in a direct message.{link}',
      zh: '请先在 c3 Web 的个人设置里发起 IM 身份绑定，再把一次性验证码发到与本机器人的私聊。{link}',
      ja: 'c3 Web の個人設定で IM 身份をバインドし、ワンタイムコードをこのロボットとの DM で送信してください。{link}',
      ko: 'c3 Web 개인 설정에서 IM 신원을 바인딩한 뒤, 일회용 코드를 이 로봇과의 DM으로 보내세요.{link}',
      ru: 'Привяжите IM-идентичность в персональных настройках c3 Web и отправьте одноразовый код этому роботу в личку.{link}',
    },
  },
  'binding.identityRequiredGroup': {
    placeholders: ['link'],
    templates: {
      en: 'IM identity binding is not available in group chats. Open c3 Web Personal settings to start binding, then complete it in a direct message with this robot.{link}',
      zh: '群内无法完成身份绑定。请先在 c3 Web 的个人设置里发起 IM 身份绑定，再在与本机器人的私聊中提交验证码。{link}',
      ja: 'グループでは IM 身份バインドはできません。c3 Web の個人設定で開始し、このロボットとの DM で完了してください。{link}',
      ko: '그룹에서는 IM 신원 바인딩을 할 수 없습니다. c3 Web 개인 설정에서 시작한 뒤 이 로봇과 DM으로 완료하세요.{link}',
      ru: 'В группе привязка IM недоступна. Начните в персональных настройках c3 Web и завершите в личке с этим роботом.{link}',
    },
  },
  'binding.useDm': {
    placeholders: [],
    templates: {
      en: 'Complete identity binding in a direct message with this robot. Group chats cannot verify codes.',
      zh: '请在与本机器人的私聊中完成身份绑定，群内无法验证。',
      ja: 'このロボットとの DM で身份バインドを完了してください。グループでは検証できません。',
      ko: '이 로봇과의 DM에서 신원 바인딩을 완료하세요. 그룹에서는 검증할 수 없습니다.',
      ru: 'Завершите привязку в личке с этим роботом. В группе коды не проверяются.',
    },
  },
  'binding.success': {
    placeholders: [],
    templates: {
      en: 'Identity binding is active. You can now ask about c3 records you are allowed to view.',
      zh: '身份绑定已生效。之后即可向我询问你有权查看的 c3 台账内容。',
      ja: '身份バインドが有効になりました。閲覧権限のある c3 記録について質問できます。',
      ko: '신원 바인딩이 활성화되었습니다. 볼 수 있는 c3 기록에 대해 질문할 수 있습니다.',
      ru: 'Привязка активна. Теперь можно спрашивать о записях c3, которые вам доступны.',
    },
  },
  'binding.failed': {
    placeholders: ['link'],
    templates: {
      en: 'Binding did not succeed. Start a new challenge in c3 Web and send the full code in a direct message.{link}',
      zh: '绑定未成功。请到 c3 Web 重新发起挑战，并在私聊中提交完整验证码。{link}',
      ja: 'バインドに失敗しました。c3 Web で新しいチャレンジを開始し、DM でコード全体を送信してください。{link}',
      ko: '바인딩에 실패했습니다. c3 Web에서 새 챌린지를 시작하고 DM으로 전체 코드를 보내세요.{link}',
      ru: 'Привязка не удалась. Создайте новый challenge в c3 Web и отправьте полный код в личку.{link}',
    },
  },
  'binding.tokenUnusable': {
    placeholders: [],
    templates: {
      en: 'That binding code cannot be used. Start a new challenge in c3 Web if you still need to bind.',
      zh: '该绑定验证码无法使用。如需绑定，请在 c3 Web 重新发起挑战。',
      ja: 'そのバインドコードは使用できません。必要なら c3 Web で新しいチャレンジを開始してください。',
      ko: '해당 바인딩 코드를 사용할 수 없습니다. 필요하면 c3 Web에서 새 챌린지를 시작하세요.',
      ru: 'Этот код привязки нельзя использовать. При необходимости создайте новый challenge в c3 Web.',
    },
  },
  'binding.scopeChanged': {
    placeholders: [],
    templates: {
      en: 'Your permissions changed. Please try again.',
      zh: '权限已变化，请重试。',
      ja: '権限が変更されました。もう一度お試しください。',
      ko: '권한이 변경되었습니다. 다시 시도해 주세요.',
      ru: 'Ваши права изменились. Попробуйте снова.',
    },
  },
  'visibility.notVisible': {
    placeholders: [],
    templates: {
      en: 'That item is not available in this chat.',
      zh: '该内容在此聊天中不可用。',
      ja: 'このチャットではその項目は利用できません。',
      ko: '이 채팅에서는 해당 항목을 사용할 수 없습니다.',
      ru: 'Этот объект недоступен в этом чате.',
    },
  },
  'visibility.groupAllHidden': {
    placeholders: ['link'],
    templates: {
      en: 'Matching results exist but are hidden in this group. Message this robot directly or open c3 Web to view them.{link}',
      zh: '存在匹配结果，但在此群中不可见。请私聊机器人或在 c3 Web 中查看。{link}',
      ja: '一致する結果がありますが、このグループでは非表示です。DM するか c3 Web で確認してください。{link}',
      ko: '일치하는 결과가 있지만 이 그룹에서는 숨겨져 있습니다. DM하거나 c3 Web에서 확인하세요.{link}',
      ru: 'Есть совпадения, но в этой группе они скрыты. Напишите роботу в личку или откройте c3 Web.{link}',
    },
  },
  'visibility.groupPartiallyHidden': {
    placeholders: ['totalCount', 'link'],
    templates: {
      en: 'Some matching results ({totalCount} total) are hidden in this group. Message this robot directly or open c3 Web for full details.{link}',
      zh: '部分匹配结果（共 {totalCount} 条）在此群中不可见。请私聊机器人或在 c3 Web 中查看完整内容。{link}',
      ja: '一致する結果の一部（合計 {totalCount} 件）がこのグループでは非表示です。DM するか c3 Web で確認してください。{link}',
      ko: '일부 일치 결과(총 {totalCount}건)가 이 그룹에서 숨겨져 있습니다. DM하거나 c3 Web에서 전체를 확인하세요.{link}',
      ru: 'Часть совпадений (всего {totalCount}) скрыта в этой группе. Напишите в личку или откройте c3 Web.{link}',
    },
  },
  'visibility.capabilityDenied': {
    placeholders: ['link'],
    templates: {
      en: 'This action is not authorized here. Open c3 Web to continue.{link}',
      zh: '此操作未获授权。请在 c3 Web 中继续。{link}',
      ja: 'この操作はここでは許可されていません。c3 Web で続行してください。{link}',
      ko: '이 작업은 여기서 허용되지 않습니다. c3 Web에서 계속하세요.{link}',
      ru: 'Это действие здесь не разрешено. Продолжите в c3 Web.{link}',
    },
  },
  'visibility.webRequired': {
    placeholders: ['link'],
    templates: {
      en: 'Complete this in c3 Web.{link}',
      zh: '请在 c3 Web 中完成此操作。{link}',
      ja: 'c3 Web で完了してください。{link}',
      ko: 'c3 Web에서 완료하세요.{link}',
      ru: 'Завершите это в c3 Web.{link}',
    },
  },
  'token.expired': {
    placeholders: [],
    templates: {
      en: 'That token has expired.',
      zh: '该令牌已过期。',
      ja: 'そのトークンは期限切れです。',
      ko: '해당 토큰이 만료되었습니다.',
      ru: 'Срок действия токена истёк.',
    },
  },
  'token.consumed': {
    placeholders: [],
    templates: {
      en: 'That token has already been used.',
      zh: '该令牌已被使用。',
      ja: 'そのトークンは既に使用されています。',
      ko: '해당 토큰은 이미 사용되었습니다.',
      ru: 'Эт token уже использован.',
    },
  },
  'token.cancelled': {
    placeholders: [],
    templates: {
      en: 'That token was cancelled.',
      zh: '该令牌已取消。',
      ja: 'そのトークンはキャンセルされました。',
      ko: '해당 토큰이 취소되었습니다.',
      ru: 'Этот токен отменён.',
    },
  },
  'token.unusable': {
    placeholders: [],
    templates: {
      en: 'That token cannot be used here.',
      zh: '该令牌无法在此使用。',
      ja: 'そのトークンはここでは使用できません。',
      ko: '해당 토큰은 여기서 사용할 수 없습니다.',
      ru: 'Этот токен здесь использовать нельзя.',
    },
  },
  'token.wrongChat': {
    placeholders: [],
    templates: {
      en: 'That token cannot be used in this chat.',
      zh: '该令牌无法在此聊天中使用。',
      ja: 'そのトークンはこのチャットでは使用できません。',
      ko: '해당 토큰은 이 채팅에서 사용할 수 없습니다.',
      ru: 'Этот токен нельзя использовать в этом чате.',
    },
  },
  'todo.answerFormatHint': {
    placeholders: [],
    templates: {
      en: 'Append one answer code after the token: `<token> <answer_id>`.',
      zh: '请在令牌后追加一个答案码：`<令牌> <answer_id>`。',
      ja: 'トークンの後に回答コードを付けてください：`<token> <answer_id>`。',
      ko: '토큰 뒤에 답변 코드를 추가하세요: `<token> <answer_id>`.',
      ru: 'Добавьте код ответа после токена: `<token> <answer_id>`.',
    },
  },
  'todo.grantMissing': {
    placeholders: [],
    templates: {
      en: 'This robot is not authorized for that action. Open c3 Web to continue.',
      zh: '该机器人未获此写能力授权。请在浏览器中打开 c3 Web 继续。',
      ja: 'このロボットにはその操作の権限がありません。c3 Web を開いて続行してください。',
      ko: '이 로봇은 해당 작업에 대한 권한이 없습니다. c3 Web을 열어 계속하세요.',
      ru: 'У этого робота нет разрешения на это действие. Откройте c3 Web.',
    },
  },
  'todo.alreadyApplied': {
    placeholders: [],
    templates: {
      en: 'That answer was already recorded.',
      zh: '该答案已记录。',
      ja: 'その回答は既に記録されています。',
      ko: '해당 답변은 이미 기록되었습니다.',
      ru: 'Этот ответ уже был записан.',
    },
  },
  'todo.applied': {
    placeholders: [],
    templates: {
      en: 'Answer recorded.',
      zh: '答案已记录。',
      ja: '回答を記録しました。',
      ko: '답변이 기록되었습니다.',
      ru: 'Ответ записан.',
    },
  },
  'todo.l2Prompt': {
    placeholders: ['token', 'answerList'],
    templates: {
      en: 'Reply with: {token} <answer_id>\n{answerList}',
      zh: '请回复：{token} <answer_id>\n{answerList}',
      ja: '返信: {token} <answer_id>\n{answerList}',
      ko: '답장: {token} <answer_id>\n{answerList}',
      ru: 'Ответ: {token} <answer_id>\n{answerList}',
    },
  },
  'runtime.timeout': {
    placeholders: [],
    templates: {
      en: 'This question timed out and was stopped.',
      zh: '这个问题处理超时了，已经中止。',
      ja: 'この質問はタイムアウトし、中止されました。',
      ko: '이 질문은 시간 초과로 중단되었습니다.',
      ru: 'Время обработки вопроса истекло, выполнение остановлено.',
    },
  },
  'runtime.blocked': {
    placeholders: ['link'],
    templates: {
      en: 'This step needs manual approval and cannot be finished in a group chat. Continue in c3.{link}',
      zh: '这一步需要人工授权，我在群里无法完成。请到 c3 中继续。{link}',
      ja: 'このステップには手動承認が必要で、グループでは完了できません。c3 で続行してください。{link}',
      ko: '이 단계는 수동 승인이 필요하며 그룹에서 완료할 수 없습니다. c3에서 계속하세요.{link}',
      ru: 'Этот шаг требует ручного одобрения и не завершается в группе. Продолжите в c3.{link}',
    },
  },
  'runtime.error': {
    placeholders: ['link'],
    templates: {
      en: 'Something went wrong while processing. Check the c3 session for details.{link}',
      zh: '处理时出错了，请到 c3 会话中查看详情。{link}',
      ja: '処理中にエラーが発生しました。c3 セッションで詳細を確認してください。{link}',
      ko: '처리 중 오류가 발생했습니다. c3 세션에서 자세히 확인하세요.{link}',
      ru: 'При обработке произошла ошибка. Подробности — в сессии c3.{link}',
    },
  },
  'runtime.guardRefused': {
    placeholders: ['link'],
    templates: {
      en: 'The answer looked like credentials and was not sent. Check the c3 session.{link}',
      zh: '回答里包含疑似凭据的内容，已拦下未发送。请到 c3 会话中查看。{link}',
      ja: '回答が凭据らしく見えたため送信されませんでした。c3 セッションを確認してください。{link}',
      ko: '답변에凭据로 보이는 내용이 있어 전송하지 않았습니다. c3 세션을 확인하세요.{link}',
      ru: 'Ответ похож на凭据 и не был отправлен. Проверьте сессию c3.{link}',
    },
  },
  'runtime.busy': {
    placeholders: [],
    templates: {
      en: 'Still working on your previous question. Ask again in a moment.',
      zh: '上一个问题还在处理，稍后再问我。',
      ja: '前の質問を処理中です。少し待ってから再度お尋ねください。',
      ko: '이전 질문을 처리 중입니다. 잠시 후 다시 물어보세요.',
      ru: 'Предыдущий вопрос ещё обрабатывается. Спросите снова чуть позже.',
    },
  },
  'runtime.storeUnavailable': {
    placeholders: [],
    templates: {
      en: 'Robot storage is unavailable. This turn did not start.',
      zh: '机器人存储不可用，本回合未启动。',
      ja: 'ロボットストレージが利用できません。このターンは開始されませんでした。',
      ko: '로봇 저장소를 사용할 수 없습니다. 이 턴은 시작되지 않았습니다.',
      ru: 'Хранилище робота недоступно. Этот ход не начался.',
    },
  },
  'runtime.inputRejectedCredential': {
    placeholders: [],
    templates: {
      en: 'Looks like credentials. The message was not processed or saved.',
      zh: '疑似凭据，未处理也未保存。',
      ja: '凭据の可能性があります。メッセージは処理・保存されませんでした。',
      ko: '凭据로 보입니다. 메시지를 처리하거나 저장하지 않았습니다.',
      ru: 'Похоже на凭据. Сообщение не обработано и не сохранено.',
    },
  },
  'runtime.inputRejectedTooLong': {
    placeholders: ['maxChars'],
    templates: {
      en: 'Message too long (over {maxChars} characters). Not processed or saved.',
      zh: '消息过长（超过 {maxChars} 个字符），未处理也未保存。',
      ja: 'メッセージが長すぎます（{maxChars} 文字超）。処理・保存されませんでした。',
      ko: '메시지가 너무 깁니다({maxChars}자 초과). 처리하거나 저장하지 않았습니다.',
      ru: 'Сообщение слишком длинное (более {maxChars} символов). Не обработано и не сохранено.',
    },
  },
  'runtime.securityError': {
    placeholders: [],
    templates: {
      en: 'This request could not be completed safely.',
      zh: '无法安全完成此请求。',
      ja: 'このリクエストは安全に完了できませんでした。',
      ko: '이 요청을 안전하게 완료할 수 없습니다.',
      ru: 'Этот запрос нельзя безопасно выполнить.',
    },
  },
  'navigation.webEntry.linked': {
    placeholders: ['link'],
    templates: {
      en: ' Open c3 Web: {link}',
      zh: ' 打开 c3 Web：{link}',
      ja: ' c3 Web を開く：{link}',
      ko: ' c3 Web 열기: {link}',
      ru: ' Открыть c3 Web: {link}',
    },
  },
  'navigation.webEntry.plain': {
    placeholders: [],
    templates: {
      en: ' Open c3 Web in your browser to continue.',
      zh: ' 请在浏览器中打开 c3 Web 完成此操作。',
      ja: ' ブラウザで c3 Web を開いて続行してください。',
      ko: ' 브라우저에서 c3 Web을 열어 계속하세요.',
      ru: ' Откройте c3 Web в браузере, чтобы продолжить.',
    },
  },
  'navigation.objectDeepLink.linked': {
    placeholders: ['link'],
    templates: {
      en: ' Open in c3 Web: {link}',
      zh: ' 在 c3 Web 中打开：{link}',
      ja: ' c3 Web で開く：{link}',
      ko: ' c3 Web에서 열기: {link}',
      ru: ' Открыть в c3 Web: {link}',
    },
  },
  'navigation.objectDeepLink.plain': {
    placeholders: [],
    templates: {
      en: ' Open c3 Web in your browser to view this item.',
      zh: ' 请在浏览器中打开 c3 Web 查看此项。',
      ja: ' ブラウザで c3 Web を開いてこの項目を表示してください。',
      ko: ' 브라우저에서 c3 Web을 열어 이 항목을 확인하세요.',
      ru: ' Откройте c3 Web в браузере, чтобы просмотреть этот объект.',
    },
  },
  'broadcast.automationPaused': {
    placeholders: ['title'],
    templates: {
      en: 'Automation "{title}" paused.',
      zh: '自动化「{title}」已暂停。',
      ja: '自動化「{title}」が一時停止しました。',
      ko: '자동화 "{title}"이(가) 일시 중지되었습니다.',
      ru: 'Автоматизация «{title}» приостановлена.',
    },
  },
  'broadcast.automationSilentTimeout': {
    placeholders: ['title'],
    templates: {
      en: 'Automation "{title}" timed out waiting silently.',
      zh: '自动化「{title}」静默等待超时。',
      ja: '自動化「{title}」が静默待機でタイムアウトしました。',
      ko: '자동화 "{title}"이(가) 무응답 대기 중 시간 초과되었습니다.',
      ru: 'Автоматизация «{title}» превысила время тихого ожидания.',
    },
  },
  'broadcast.automationRetriesExhausted': {
    placeholders: ['title'],
    templates: {
      en: 'Automation "{title}" exhausted retries.',
      zh: '自动化「{title}」重试次数已用尽。',
      ja: '自動化「{title}」の再試行回数が尽きました。',
      ko: '자동화 "{title}"의 재시도 횟수를 모두 사용했습니다.',
      ru: 'Автоматизация «{title}» исчерпала повторы.',
    },
  },
  'broadcast.specPendingReview': {
    placeholders: ['title'],
    templates: {
      en: 'Spec for "{title}" awaits review.',
      zh: '「{title}」的 spec 待审核。',
      ja: '「{title}」の spec がレビュー待ちです。',
      ko: '"{title}" spec이 검토 대기 중입니다.',
      ru: 'Spec для «{title}» ожидает проверки.',
    },
  },
  'broadcast.permissionRequestQueued': {
    placeholders: ['title'],
    templates: {
      en: 'Permission request queued for "{title}".',
      zh: '「{title}」的权限请求已入队。',
      ja: '「{title}」の権限リクエストがキューに入りました。',
      ko: '"{title}"에 대한 권한 요청이 대기열에 추가되었습니다.',
      ru: 'Запрос разрешения для «{title}» поставлен в очередь.',
    },
  },
  'broadcast.deliveryPendingReview': {
    placeholders: ['title'],
    templates: {
      en: 'Delivery "{title}" awaits manual review.',
      zh: '交付「{title}」待人工审核。',
      ja: 'デリバリー「{title}」が手動レビュー待ちです。',
      ko: '交付 "{title}"이(가) 수동 검토 대기 중입니다.',
      ru: '交付 «{title}» ожидает ручной проверки.',
    },
  },
  'broadcast.mainlineDrift': {
    placeholders: ['title'],
    templates: {
      en: 'Mainline drift detected for "{title}".',
      zh: '「{title}」检测到主线漂移。',
      ja: '「{title}」でメインラインのドリフトを検出しました。',
      ko: '"{title}"에서 mainline drift가 감지되었습니다.',
      ru: 'Обнаружен drift основной ветки для «{title}».',
    },
  },
}

export function isRobotMessageLocale(value: string): value is RobotMessageLocale {
  return (ROBOT_MESSAGE_LOCALES as readonly string[]).includes(value)
}

export function isRobotMessageKey(value: string): value is RobotMessageKey {
  return (ROBOT_MESSAGE_KEYS as readonly string[]).includes(value)
}

/** Compile-time alignment with Web UiLang. */
const _uiLangAlign: readonly UiLang[] = ROBOT_MESSAGE_LOCALES
void _uiLangAlign
