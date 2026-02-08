import type { MessageSegment } from "./message";

export type ActionResponse<TData = unknown> = {
  status?: string;
  retcode?: number;
  data?: TData;
  msg?: string;
  wording?: string;
  echo?: string;
  [key: string]: unknown;
};

type SendPrivateMsgParams = {
  user_id: number;
  message: MessageSegment[];
};

type SendGroupMsgParams = {
  group_id: number;
  message: MessageSegment[];
};

type SetGroupAddRequestParams = {
  flag: string;
  sub_type?: string;
  approve: boolean;
  reason?: string;
};

type SetFriendAddRequestParams = {
  flag: string;
  approve: boolean;
  remark?: string;
};

type GetStatusParams = Record<string, never>;

export type NapcatActionMap = {
  send_private_msg: {
    params: SendPrivateMsgParams;
    data: Record<string, unknown>;
  };
  send_group_msg: {
    params: SendGroupMsgParams;
    data: Record<string, unknown>;
  };
  set_group_add_request: {
    params: SetGroupAddRequestParams;
    data: Record<string, unknown>;
  };
  set_friend_add_request: {
    params: SetFriendAddRequestParams;
    data: Record<string, unknown>;
  };
  get_status: {
    params: GetStatusParams;
    data: Record<string, unknown>;
  };
};

export type NapcatActionName = keyof NapcatActionMap;

export type ActionParams<TAction extends NapcatActionName> = NapcatActionMap[TAction]["params"];

export type ActionData<TAction extends NapcatActionName> = NapcatActionMap[TAction]["data"];

export type ActionPayload<TAction extends NapcatActionName> = {
  action: TAction;
  params: ActionParams<TAction>;
  echo: string;
};

export function buildActionPayload<TAction extends NapcatActionName>(
  action: TAction,
  params: ActionParams<TAction>,
  echo: string,
): ActionPayload<TAction> {
  return { action, params, echo };
}

export function createSendPrivateMsgParams(
  userId: number,
  message: MessageSegment[],
): SendPrivateMsgParams {
  return {
    user_id: userId,
    message,
  };
}

export function createSendGroupMsgParams(
  groupId: number,
  message: MessageSegment[],
): SendGroupMsgParams {
  return {
    group_id: groupId,
    message,
  };
}

export function createGetStatusParams(): GetStatusParams {
  return {};
}

export function createSetGroupAddRequestParams(
  flag: string,
  subType: string | undefined,
  approve: boolean,
): SetGroupAddRequestParams {
  return {
    flag,
    sub_type: subType,
    approve,
  };
}

export function createSetFriendAddRequestParams(
  flag: string,
  approve: boolean,
): SetFriendAddRequestParams {
  return {
    flag,
    approve,
  };
}
